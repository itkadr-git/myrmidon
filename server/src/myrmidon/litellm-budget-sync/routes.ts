// server/src/myrmidon/litellm-budget-sync/routes.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the settings, status and re-sync API.
//
//   GET   /api/myrmidon/companies/:companyId/litellm-budget-sync/settings
//         — the stored document + the sweep interval and its source
//           (company access; the UI renders the source next to each value).
//   PUT   /api/myrmidon/companies/:companyId/litellm-budget-sync/settings
//         — the public document (board only). A successful save asks the
//           sweep for one immediate pass, so a changed limit reaches LiteLLM
//           within seconds — well inside the ≤ 60 s criterion.
//   GET   /api/myrmidon/companies/:companyId/litellm-budget-sync/status
//         — the current divergences (company access, read-only pass).
//   POST  /api/myrmidon/companies/:companyId/litellm-budget-sync/re-sync
//         — one forced projection pass on demand (board only): every
//           projection target is re-written from the board's limits.
//
// All reads answer the source of every value ("settings" / "env" /
// "default") — the SETTINGS-TO-UI contract.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { budgetProjectionSettingsSchema } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/index.js";
import { runBudgetProjectionPass } from "./sweep.js";
import {
  parseBudgetProjectionSettings,
  resolveBudgetProjectionRuntime,
  mutateBudgetProjectionDocument,
  BUDGET_PROJECTION_SWEEP_INTERVAL_ENV,
} from "./settings.js";

export function litellmBudgetSyncRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();

  const settingsView = async (companyId: string) => {
    const runtime = await resolveBudgetProjectionRuntime(db, companyId, env);
    return {
      enabled: runtime.settings.enabled,
      signalOnly: runtime.settings.signalOnly,
      limits: runtime.settings.limits,
      sweepIntervalSec: runtime.sweepIntervalSec,
      sweepIntervalSource: runtime.sweepIntervalSource,
      sweepIntervalEnvName: BUDGET_PROJECTION_SWEEP_INTERVAL_ENV,
    };
  };

  const notConfigured = (res: import("express").Response) => {
    res.status(503).json({ error: "LLM gateway budget projection is not configured", enabled: false });
  };
  const configured = () =>
    Boolean(env["MYRMIDON_LITELLM_BASE_URL"]?.trim() && env["MYRMIDON_LITELLM_ADMIN_KEY_SECRET"]?.trim());

  router.get("/myrmidon/companies/:companyId/litellm-budget-sync/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await settingsView(companyId));
  });

  router.put(
    "/myrmidon/companies/:companyId/litellm-budget-sync/settings",
    validate(budgetProjectionSettingsSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const next = parseBudgetProjectionSettings(req.body);
      // The stored `projected` map survives a PUT: only a changed limit
      // re-projects (the three-way comparison in service.ts decides).
      await mutateBudgetProjectionDocument(db, companyId, (current) => ({
        next: { ...next, projected: current.projected },
        result: null,
      }));
      const actor = getActorInfo(req);
      try {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: "myrmidon.budget_projection.settings_saved",
          entityType: "budget_projection_settings",
          entityId: companyId,
          details: {
            enabled: next.enabled,
            signalOnly: next.signalOnly,
            limits: next.limits.length,
            sweepIntervalSec: next.sweepIntervalSec,
          },
        });
      } catch {
        // a failed journal row must not lose the saved document
      }
      res.json(await settingsView(companyId));
    },
  );

  router.get("/myrmidon/companies/:companyId/litellm-budget-sync/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!configured()) {
      notConfigured(res);
      return;
    }
    // Read-only divergence listing: run one pass without forcing writes and
    // without re-signalling (the sweep owns delivery); the projection side
    // effect is idempotent — nothing is written when nothing changed.
    const result = await runBudgetProjectionPass(db, companyId, env);
    if (!result) {
      notConfigured(res);
      return;
    }
    res.json({ divergences: result.divergences });
  });

  router.post("/myrmidon/companies/:companyId/litellm-budget-sync/re-sync", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!configured()) {
      notConfigured(res);
      return;
    }
    // Forced: every target is re-written from the board's limits and the
    // projected map is refreshed — the sanctioned way out of a divergence.
    const result = await runBudgetProjectionPass(db, companyId, env, { force: true });
    if (!result) {
      notConfigured(res);
      return;
    }
    res.json(result);
  });

  return router;
}

/** The wiring for app.ts. */
export function myrmidonLitellmBudgetSyncRoutes(db: Db) {
  return litellmBudgetSyncRoutes(db);
}
