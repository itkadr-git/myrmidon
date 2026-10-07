// server/src/myrmidon/model-providers/routes-with-sync.ts
//
// myrmidon(1.6.1 MODEL-PROVIDERS B): model provider API with LiteLLM synchronization.
//
// Same surface as part A's routes.ts (paths, authz, parsing, responses), plus
// the gateway propagation on the three mutations that change the company's
// model set:
//
//  - POST …/:id/models (enable/disable): the new state is persisted first,
//    then every toggled model is registered in / unregistered from LiteLLM
//    and the agents' key allowlists are re-applied.
//  - PATCH …/:id with a key (rotation): after the credential rotates, the
//    provider's enabled models are re-registered under the same credential
//    NAME, then the allowlists re-applied.
//  - DELETE …/:id: the provider's enabled models are unregistered from the
//    gateway after the row is removed (otherwise they would stay callable
//    under a credential the company no longer owns).
//
// Synchronization is instance-optional and company-resolved: `getLitellmSync`
// answers the per-company sync service, or null when the gateway settings or
// the company's admin-key secret are absent — then these routes behave exactly
// as part A. A mutation whose sync step failed answers 422
// (`litellm_sync_failed`): the persisted database state — the source of truth —
// stands, and the startup reconciliation converges the gateway.
//
// Gateway writes of one company are serialized by the process guard in
// litellm-sync/lock.ts, so two board requests cannot race the same registry.

import { Router, type Request } from "express";
import {
  createModelProviderSchema,
  patchModelProviderSchema,
  setModelProviderModelsSchema,
} from "@paperclipai/shared";
import type { ZodType } from "zod";
import { badRequest, HttpError } from "../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import type {
  ModelProviderActivityEntry,
  ModelProviderModelView,
  ModelProviderService,
} from "./service.js";
import type { LitellmSyncService } from "../litellm-sync/service.js";
import { withCompanySyncGuard } from "../litellm-sync/lock.js";

export interface ModelProviderRoutesWithSyncDeps {
  service: ModelProviderService;
  /**
   * The per-company LiteLLM sync service, or null when gateway sync is not
   * configured for this instance or this company has no admin-key value.
   */
  getLitellmSync: (companyId: string) => Promise<LitellmSyncService | null>;
  /**
   * Re-applies the enabled-model allowlist to the company's agent gateway
   * keys. Optional: tests pass none; without it the allowlist step is skipped.
   * Must not throw on a gateway it cannot reach — it reports and returns.
   */
  refreshAgentAllowlists?: (companyId: string) => Promise<unknown>;
  /** Writes the mutation into the company activity log. Optional: tests pass none. */
  recordActivity?: (entry: ModelProviderActivityEntry) => Promise<void>;
}

function bodyOf(req: Request): Record<string, unknown> {
  const body = req.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * A persisted mutation whose gateway propagation failed: 422 with
 * `litellm_sync_failed` — the same shape every gateway call in this codebase
 * answers (agent-keys, litellm-sync client map a failed LiteLLM call to 422).
 * The database state (the source of truth) stays and the gateway converges on
 * the next enable/disable pass or the startup reconciliation.
 */
function syncFailed(err: unknown): HttpError {
  const detail = err instanceof HttpError ? (err.details as Record<string, unknown> | undefined) : undefined;
  return new HttpError(422, "LiteLLM synchronization failed", {
    code: "litellm_sync_failed",
    reason: err instanceof Error ? err.message : String(err),
    ...(detail?.code ? { gatewayCode: detail.code, gatewayStatus: detail.status } : {}),
  });
}

export function modelProviderRoutesWithSync(deps: ModelProviderRoutesWithSyncDeps): Router {
  const router = Router();
  const activity = (entry: ModelProviderActivityEntry) =>
    deps.recordActivity ? deps.recordActivity(entry) : Promise.resolve();

  const parse = <T>(schema: ZodType<T>, body: unknown): T => {
    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error?.issues ?? [];
      const first = issues[0];
      const path = first?.path?.length ? `${first.path.join(".")}: ` : "";
      throw badRequest(`${path}${first?.message ?? "invalid request body"}`);
    }
    return result.data;
  };

  /**
   * Runs one gateway propagation for a company under its serialization guard.
   * A no-op when sync is not configured (part-A behavior); any gateway error
   * surfaces as the 422 `syncFailed`, never swallowed.
   */
  const propagate = async (companyId: string, fn: (sync: LitellmSyncService) => Promise<void>) => {
    try {
      await withCompanySyncGuard(companyId, async () => {
        const sync = await deps.getLitellmSync(companyId);
        if (!sync) return;
        await fn(sync);
      });
    } catch (err) {
      throw syncFailed(err);
    }
  };

  router.post("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(createModelProviderSchema, bodyOf(req));
    const provider = await deps.service.createProvider({
      companyId,
      body,
      activity: (entry) => activity(entry),
    });
    res.status(201).json(provider);
  });

  router.get("/myrmidon/companies/:companyId/model-providers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ providers: await deps.service.listProviders(companyId) });
  });

  router.patch("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(patchModelProviderSchema, bodyOf(req));
    if (body.key !== undefined) {
      const view = await deps.service.rotateProviderKey({
        companyId,
        providerId,
        key: body.key,
        activity: (entry) => activity(entry),
      });
      // The credential name the gateway reads is unchanged (part A rotates
      // the store under the same name); re-register the enabled models so the
      // gateway reloads the value, then re-apply the agent allowlists.
      await propagate(companyId, async (sync) => {
        await sync.handleProviderCredentialRotation(companyId, providerId);
        if (deps.refreshAgentAllowlists) await deps.refreshAgentAllowlists(companyId);
      });
      res.json(view);
      return;
    }
    const view = await deps.service.patchProvider({
      companyId,
      providerId,
      body,
      activity: (entry) => activity(entry),
    });
    res.json(view);
  });

  router.delete("/myrmidon/companies/:companyId/model-providers/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    // Read the model set before the row goes: after deletion the board can no
    // longer name what the gateway still holds under this provider.
    const models: ModelProviderModelView[] = await deps.service.listModels(companyId, providerId);
    await deps.service.removeProvider({
      companyId,
      providerId,
      activity: (entry) => activity(entry),
    });
    const enabledNames = models.filter((m) => m.enabled).map((m) => m.litellmModelName);
    if (enabledNames.length > 0) {
      await propagate(companyId, async (sync) => {
        await sync.unregisterModels(enabledNames);
        if (deps.refreshAgentAllowlists) await deps.refreshAgentAllowlists(companyId);
      });
    }
    res.status(204).send();
  });

  router.get("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    res.json({ models: await deps.service.listModels(companyId, providerId) });
  });

  router.post("/myrmidon/companies/:companyId/model-providers/:id/models", async (req, res) => {
    const companyId = req.params.companyId as string;
    const providerId = req.params.id as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const body = parse(setModelProviderModelsSchema, bodyOf(req));

    // Persist first: the answer's model rows carry the authoritative state.
    const models = await deps.service.setModels({
      companyId,
      providerId,
      models: body.models,
    });

    const toggled = body.models.filter((m) => m.enabled !== undefined);
    if (toggled.length > 0) {
      await propagate(companyId, async (sync) => {
        for (const change of toggled) {
          const after = models.find((m) => m.modelName === change.modelName);
          if (!after || after.enabled === undefined) continue;
          await sync.handleModelEnableDisable(
            companyId,
            providerId,
            change.modelName,
            after.enabled,
          );
        }
        if (deps.refreshAgentAllowlists) await deps.refreshAgentAllowlists(companyId);
      });
    }

    res.json({ models });
  });

  return router;
}
