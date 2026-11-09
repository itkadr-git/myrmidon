// server/src/myrmidon/litellm-keys/routes.ts
//
// myrmidon(M2-B): the key-management API.
//
//   GET  /api/myrmidon/companies/:companyId/litellm/keys            (company access)
//   POST /api/myrmidon/companies/:companyId/litellm/keys/allowlist-sync (owner/admin; dry run unless ?apply=true)
//   GET  /api/myrmidon/companies/:companyId/litellm/keys/:agentId   (company access; an agent only for itself)
//   POST /api/myrmidon/companies/:companyId/litellm/keys/:agentId   (board only)
//   POST /api/myrmidon/companies/:companyId/litellm/keys/:agentId/rotate (board only)
//
// Reads answer the state of a key — its store name and the sha256 of its value,
// never the value. A create or a rotation is board-only: it mints a credential
// and calls the gateway. When the instance has no gateway admin key configured
// the endpoints answer 503 with `enabled: false`, the same shape M2-A's cost
// endpoints use, so the interface can say why instead of showing a bare error.

import { Router, type Request, type Response } from "express";
import type { Db } from "@myrmidon/db";
import { missingGatewayEnv, readGatewayKeySettings, type GatewayKeySettings } from "@myrmidon/shared";
import { badRequest } from "../../errors.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdmin, getActorInfo } from "../../routes/authz.js";
import {
  assertAgentMayReadOwnGatewayKey,
  createAgentGatewayKey,
  defaultAgentGatewayKeyDeps,
  listAgentGatewayKeys,
  readAgentGatewayKey,
  revokeAgentGatewayKey,
  rotateAgentGatewayKey,
  updateAgentGatewayKeyAllowlist,
  type AgentGatewayKeyDeps,
} from "./agent-keys.js";
import { readGatewayFallbackTopology, updateGatewayFallbackTopology } from "./fallback-cycles.js";
import { listLitellmModels, type LitellmModelView } from "../litellm-costs/litellm-costs.js";
import { GATEWAY_NOT_CONFIGURED_CODE } from "../litellm-sync/config-client.js";
import type { FallbackChain, KnownModelInfo } from "@myrmidon/shared";
import { readCompanyKeyBudgets } from "./key-budget-adapter.js";
import { createLiteLlmAuditService } from "../litellm-audit/service.js";
import { updateAgentAllowlistsForCompany } from "../litellm-sync/agent-allowlist-handler.js";
import { withCompanySyncGuard } from "../litellm-sync/lock.js";

export interface LitellmKeysRoutesDeps {
  deps: AgentGatewayKeyDeps;
  env?: NodeJS.ProcessEnv;
  /**
   * The model catalog the fallback checks read. Absent: the latest rows of the
   * cost sweep's catalog.
   */
  listModels?: () => Promise<LitellmModelView[]>;
}

/**
 * The fallback topology of a request body: a list of `{model, targets}`.
 * Anything else is a 400 — an absent list must never read as "clear every
 * chain", because the write replaces the gateway's whole list.
 */
function readChainsBody(body: unknown): FallbackChain[] {
  const raw = (body as { chains?: unknown } | null | undefined)?.chains;
  if (!Array.isArray(raw)) throw badRequest("chains must be a list of {model, targets} entries");
  return raw.map((entry, index) => {
    const model = (entry as { model?: unknown } | null)?.model;
    const targets = (entry as { targets?: unknown } | null)?.targets;
    if (
      typeof model !== "string" ||
      !Array.isArray(targets) ||
      targets.some((target) => typeof target !== "string")
    ) {
      throw badRequest(`chains[${index}] must have a model name and a list of target names`);
    }
    return { model, targets: targets as string[] };
  });
}

export function litellmKeysRoutes(db: Db, input: LitellmKeysRoutesDeps) {
  const router = Router();
  const env = input.env ?? process.env;
  const settings = () => readGatewayKeySettings(env);
  const auditService = createLiteLlmAuditService(db);
  const disabled = (res: Response) => {
    res.status(503).json({ error: "LLM gateway key management is not enabled", enabled: false });
  };
  /**
   * The fallback endpoints answer the same 503 with a code and the names of
   * the missing settings, so the screen can say what to set.
   */
  const gatewayNotConfigured = (res: Response, current: GatewayKeySettings) => {
    const missing = missingGatewayEnv(current);
    res.status(503).json({
      error: `LLM gateway fallback management is not enabled: set ${missing.join(" and ")}`,
      code: GATEWAY_NOT_CONFIGURED_CODE,
      enabled: false,
      missing,
    });
  };
  const listCatalog = input.listModels ?? (() => listLitellmModels(db));

  router.get("/myrmidon/companies/:companyId/litellm/keys", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    res.json(await listAgentGatewayKeys(input.deps, companyId));
  });

  router.get("/myrmidon/companies/:companyId/litellm/key-budgets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    res.json(await readCompanyKeyBudgets(input.deps, companyId));
  });

  /**
   * Company-wide pass that sets every restricted agent key to the company's
   * enabled registry models: it adds the enabled names a key lacks and drops
   * the registry names that are no longer enabled; names the registry does not
   * own are kept, and a key with no restriction (all models) is left alone.
   *
   * A DRY RUN by default: it reads the keys and answers what would change
   * (`dryRun.changes` per agent, `added` / `removed` per model name) and sends
   * nothing. Only `?apply=true` writes. Applying widens every curated list by
   * the enabled names, so it is an explicit owner/admin action: the startup
   * check and the provider-change hooks only report.
   *
   * Registered before the `/:agentId` routes, which would take "allowlist-sync"
   * for an agent id.
   */
  router.post("/myrmidon/companies/:companyId/litellm/keys/allowlist-sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAdmin(req, companyId);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    const applyParam = String(req.query.apply ?? "").trim().toLowerCase();
    const apply = applyParam === "true" || applyParam === "1";
    const result = await withCompanySyncGuard(companyId, () =>
      updateAgentAllowlistsForCompany(db, input.deps, companyId, [], [], false, { apply }),
    );
    if (apply) {
      const actor = getActorInfo(req);
      try {
        await auditService.record({
          companyId,
          category: "keys",
          action: "litellm_key_allowlists_synced",
          entityId: companyId,
          actor: { type: actor.actorType, id: actor.actorId },
          before: null,
          after: { attempted: result.attempted, updated: result.updated, skipped: result.skipped.length },
          summary: `Applied the enabled-model allowlist to ${result.updated} of ${result.attempted} agent gateway keys`,
          canRollback: false,
        });
      } catch {
        // The keys are already changed; a failed audit row must not hide that.
      }
    }
    res.json({ mode: apply ? "apply" : "dry-run", applied: apply, ...result });
  });

  router.get("/myrmidon/companies/:companyId/litellm/keys/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertAgentMayReadOwnGatewayKey({
      actorType: req.actor.type,
      actorAgentId: req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
      requestedAgentId: agentId,
    });
    res.json(await readAgentGatewayKey(input.deps, { companyId, agentId }));
  });

  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    const models = Array.isArray(req.body?.models)
      ? (req.body.models as unknown[]).map(String)
      : undefined;
    const created = await createAgentGatewayKey(input.deps, { companyId, agentId, models });
    const actor = getActorInfo(req);
    await auditService.record({
      companyId, category: "keys", action: "litellm_key_created", entityId: agentId,
      actor: { type: actor.actorType, id: actor.actorId }, before: null,
      after: { agentId, allowedModels: created.view.models },
      summary: `Created gateway key for agent ${agentId}`, canRollback: false,
    });
    // The value is answered exactly once, to the board member who asked for it.
    res.status(201).json({ ...created.view, value: created.value });
  });

  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId/rotate", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    const rotated = await rotateAgentGatewayKey(input.deps, { companyId, agentId });
    const actor = getActorInfo(req);
    await auditService.record({
      companyId,
      category: "keys",
      action: "litellm_key_rotated",
      entityId: agentId,
      actor: { type: actor.actorType, id: actor.actorId },
      before: { rotated: false },
      after: { rotated: true, allowedModels: rotated.models },
      summary: `Rotated gateway key for agent ${agentId}`,
      canRollback: false,
    });
    res.json(rotated);
  });

  const handleRevoke = async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    res.json(await revokeAgentGatewayKey(input.deps, { companyId, agentId }));
  };
  router.delete("/myrmidon/companies/:companyId/litellm/keys/:agentId", handleRevoke);
  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId/revoke", handleRevoke);

  const handleUpdateAllowlist = async (req: Request, res: Response) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!settings().canManageKeys) {
      disabled(res);
      return;
    }
    const models = Array.isArray(req.body?.models)
      ? (req.body.models as unknown[]).map(String)
      : [];
    res.json(await updateAgentGatewayKeyAllowlist(input.deps, { companyId, agentId, models }));
  };
  router.put("/myrmidon/companies/:companyId/litellm/keys/:agentId/models", handleUpdateAllowlist);
  router.post("/myrmidon/companies/:companyId/litellm/keys/:agentId/models", handleUpdateAllowlist);
  router.patch("/myrmidon/companies/:companyId/litellm/keys/:agentId", handleUpdateAllowlist);

  /**
   * The gateway's fallback topology, with its loops named. Exposed so an
   * operator can see BEFORE a write what a save would reject, and so the
   * deployed topology is checked against the same walk the save path uses —
   * the loops in it were found this way, not by the write path.
   */
  router.get("/myrmidon/companies/:companyId/litellm/fallbacks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const current = settings();
    if (!current.canManageKeys || !current.baseUrl) {
      gatewayNotConfigured(res, current);
      return;
    }
    const report = await readGatewayFallbackTopology(input.deps, { companyId, settings: current });
    try {
      const known = await listCatalog();
      report.models = known.map((m) => ({
        modelName: m.modelName,
        provider: m.provider,
        inputCostPerToken: m.inputCostPerToken,
        outputCostPerToken: m.outputCostPerToken,
        isFree: (m.inputCostPerToken === 0 && m.outputCostPerToken === 0) || !m.inputCostPerToken,
      }));
    } catch {
      // models are optional if litellmModels table is unpopulated
    }
    res.json(report);
  });

  /**
   * Replaces the gateway's fallback topology through LiteLLM /config/update,
   * with the whole list. Refuses loops, empty chains, unknown model groups and
   * an order that breaks the free-first, cheaper-first policy. A fallback
   * inside one provider is allowed and comes back as a warning.
   */
  router.put("/myrmidon/companies/:companyId/litellm/fallbacks", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const current = settings();
    if (!current.canManageKeys || !current.baseUrl) {
      gatewayNotConfigured(res, current);
      return;
    }

    const chains = readChainsBody(req.body);
    let catalog: Map<string, KnownModelInfo> | undefined;
    try {
      const known = await listCatalog();
      catalog = new Map(
        known.map((m) => [
          m.modelName,
          {
            modelName: m.modelName,
            provider: m.provider,
            inputCostPerToken: m.inputCostPerToken,
            outputCostPerToken: m.outputCostPerToken,
            isFree: (m.inputCostPerToken === 0 && m.outputCostPerToken === 0) || !m.inputCostPerToken,
          },
        ]),
      );
    } catch {
      catalog = new Map();
    }

    const updated = await updateGatewayFallbackTopology(input.deps, {
      companyId,
      settings: current,
      chains,
      catalog,
    });
    res.json(updated);
  });

  return router;
}

/** The real wiring for app.ts. */
export function myrmidonLitellmKeysRoutes(db: Db) {
  return litellmKeysRoutes(db, { deps: defaultAgentGatewayKeyDeps(db) });
}