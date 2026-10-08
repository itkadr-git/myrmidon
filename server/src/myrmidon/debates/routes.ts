// server/src/myrmidon/debates/routes.ts
//
// myrmidon(1.7-DEBATE-ASYM-A): the board-facing REST API for debates.
//
//   GET    /api/myrmidon/debate/settings
//   PATCH  /api/myrmidon/debate/settings                      (instance admin)
//   POST   /api/myrmidon/companies/:companyId/debates/issues/:issueId/run
//
// The settings pair follows BUDGET-CONFIG-B: GET reports the effective
// configuration and where the value came from (stored row, forced env
// override, or the built-in default) so the UI shows the source; PATCH writes
// `instance_settings.general.debate` — a symmetric or malformed configuration
// is refused with 422 and the exact reason, and the change applies to the
// next run without a restart.
//
// The run endpoint is for both the board and an agent, per the autonomy
// matrix (owner rule): the board caller is not subject to the matrix, an
// agent caller is gated on `spend_above_threshold` — a debate is a gateway
// spend. `forbidden` answers 403; `approval_required` answers 403 with the
// approval code (the same interim shape the AUTONOMY-MATRIX routes use until
// the held-action follow-up exists for invocation-less routes).

import { Router } from "express";
import { eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
import type { DebateSettings } from "@paperclipai/shared";
import { dbAutonomyGate } from "../autonomy/gate.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { forbidden } from "../../errors.js";
import {
  costService,
  documentService,
  instanceSettingsService,
  logActivity,
  secretService,
} from "../../services/index.js";
import {
  createDebateGatewayCall,
  debateGatewayProblem,
  readDebateGatewaySettings,
} from "./gateway.js";
import { readDebateSettings } from "./settings.js";
import { debateService, DebateConfigError, type DebateService } from "./service.js";

export const DEBATE_ACTOR_ID = "myrmidon-debates";

/** Body of PATCH /myrmidon/debate/settings: the config, or null to clear the row. */
interface DebateSettingsPatchBody {
  settings?: DebateSettings | null;
}

function parseRunBody(body: unknown): { question?: string } | { error: string } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.question !== undefined && b.question !== null && typeof b.question !== "string") {
    return { error: "question must be a string" };
  }
  return typeof b.question === "string" ? { question: b.question } : {};
}

export function debateRoutes(db: Db, service: DebateService, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();

  router.get("/myrmidon/debate/settings", async (req, res) => {
    // Board-readable like the budget-enforcement GET; the config itself
    // carries no secret values, only model names.
    assertBoardOrgAccess(req);
    const view = await service.settingsView();
    // The gateway contour is reported next to the roles so the UI can say why
    // a run would refuse before the operator tries one.
    const gateway = readDebateGatewaySettings(env);
    res.json({
      ...view,
      gateway: { configured: gateway.enabled, problem: debateGatewayProblem(gateway) },
    });
  });

  router.patch("/myrmidon/debate/settings", async (req, res) => {
    // Instance admin only, the same rule the rest of the instance settings
    // and the budget-enforcement PATCH follow.
    assertInstanceAdmin(req);
    const body = (req.body ?? {}) as DebateSettingsPatchBody;
    try {
      const view = await service.saveSettings(body.settings ?? null);
      res.json(view);
    } catch (error) {
      if (error instanceof DebateConfigError) {
        // A symmetric or malformed configuration is the caller's input error:
        // the exact reason is the body, nothing is stored.
        res.status(422).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  });

  router.post("/myrmidon/companies/:companyId/debates/issues/:issueId/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);

    // Autonomy matrix: a debate spends gateway calls, so agents are gated on
    // the spend class; the board caller bypasses the gate (it owns the matrix).
    const gate = dbAutonomyGate(db);
    const verdict = await gate.decide(req, "spend_above_threshold");
    if (verdict.verdict === "forbidden") {
      throw forbidden("This action is forbidden for this role by the autonomy matrix", {
        code: "autonomy_forbidden",
        actionClass: "spend_above_threshold",
        role: verdict.role,
      });
    }
    if (verdict.verdict === "approval_required") {
      throw forbidden("This action requires approval under the autonomy matrix", {
        code: "autonomy_approval_required",
        actionClass: "spend_above_threshold",
        role: verdict.role,
      });
    }

    const parsed = parseRunBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // The gateway must be configured to spend anything; refuse before the
    // engine starts, the same way evals mutations answer 503 unconfigured.
    const gateway = readDebateGatewaySettings(env);
    const gatewayProblem = debateGatewayProblem(gateway);
    if (gatewayProblem) {
      res.status(503).json({ error: gatewayProblem, enabled: false });
      return;
    }

    const actor = getActorInfo(req);
    try {
      const result = await service.run(
        { companyId, issueId, question: parsed.question },
        {
          agentId: actor.actorType === "agent" ? actor.agentId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
          runId: actor.runId,
        },
      );
      res.json({
        issueId: result.issueId,
        documentKey: result.documentKey,
        costRecorded: result.costRecorded,
        outcome: result.outcome,
      });
    } catch (error) {
      if (error instanceof DebateConfigError) {
        if (error.code === "debate_key_missing") {
          res.status(503).json({ error: error.message, code: error.code });
          return;
        }
        const status = error.code === "debate_issue_not_found" ? 404 : error.code === "debate_config_rejected" ? 422 : 400;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      // Gateway/model failures are upstream problems, not caller errors.
      res.status(502).json({ error: (error as Error).message });
    }
  });

  return router;
}

/** The production service wired to the database, the gateway contour and instance settings. */
export function debateServiceForDb(db: Db, env: NodeJS.ProcessEnv = process.env): DebateService {
  const settings = instanceSettingsService(db);
  return debateService({
    loadIssue: async (issueId) =>
      db
        .select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    readSettings: () => readDebateSettings({ getGeneral: () => settings.getGeneral(), env }),
    writeSettings: async (value: DebateSettings | null) => {
      // updateGeneral merges { debate: value } into the row; the preserve key
      // in instance-settings.ts keeps it alive across every later vendor
      // write. A null clears the row (the env/default level applies again).
      await settings.updateGeneral({ debate: value });
      return readDebateSettings({ getGeneral: () => settings.getGeneral(), env });
    },
    callModel: async (companyId) => {
      const contour = readDebateGatewaySettings(env);
      const secrets = secretService(db);
      const row = contour.keySecret ? await secrets.getByName(companyId, contour.keySecret) : null;
      if (!row) {
        throw new DebateConfigError(
          "debate_key_missing",
          `the debate gateway key secret "${contour.keySecret ?? "—"}" is not available for this company`,
        );
      }
      const apiKey = await secrets.resolveSecretValue(companyId, row.id, "latest");
      if (!apiKey) {
        throw new DebateConfigError("debate_key_missing", `the debate gateway key secret "${contour.keySecret}" could not be resolved`);
      }
      return createDebateGatewayCall({
        fetch,
        apiKey,
        baseUrl: contour.baseUrl!,
        timeoutMs: contour.timeoutMs,
      });
    },
    writeDocument: async (input) => {
      const documents = documentService(db);
      await documents.upsertIssueDocument({
        issueId: input.issueId,
        key: input.key,
        title: input.title,
        format: "markdown",
        body: input.body,
        createdByAgentId: input.actorAgentId,
        createdByUserId: input.actorUserId,
        createdByRunId: input.runId,
        changeSummary: "Asymmetric debate run (DEBATE-ASYM A)",
      });
    },
    recordCost: async (input) => {
      // Without an agent identity there is no cost_events row (the table is
      // agent-scoped); the debate spend then lives in the activity log only.
      if (!input.agentId) return;
      await costService(db).createEvent(input.companyId, {
        agentId: input.agentId,
        issueId: input.issueId,
        billingCode: "myrmidon-debate",
        provider: "gateway",
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costCents: input.costCents,
        occurredAt: new Date(),
      });
    },
    logActivity: async (input) => {
      const actorType = input.actorAgentId ? "agent" : input.actorUserId ? "user" : "system";
      const actorId = input.actorAgentId ?? input.actorUserId ?? DEBATE_ACTOR_ID;
      await logActivity(db, {
        companyId: input.companyId,
        actorType,
        actorId,
        agentId: input.actorAgentId,
        action: input.action,
        entityType: "debate",
        entityId: input.entityId,
        details: input.details,
      });
    },
    now: () => new Date(),
  });
}
