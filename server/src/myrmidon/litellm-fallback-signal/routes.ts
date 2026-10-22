// server/src/myrmidon/litellm-fallback-signal/routes.ts
//
// myrmidon(BOT-RUNTIME-TUNING D2): the settings and live-status API of the
// model fallback signal.
//
// - GET   /api/myrmidon/model-fallback/settings
//   The effective values and the origin of each one (`settings`, `env` or
//   `default`). Any board member reads.
// - PATCH /api/myrmidon/model-fallback/settings
//   A partial patch, merged over the effective values and stored in
//   `instance_settings.general.modelFallbackSignal`. Instance admins write.
//   The sweep reads the row on its next tick, so the change applies without a
//   restart — that is the whole point of the endpoint.
// - GET   /api/myrmidon/companies/:companyId/model-fallback/status
//   The last sweep's per-agent rows plus the effective numbers. Company
//   members read; this is what the agent card shows.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  FALLBACK_SIGNAL_SETTINGS_KEY,
  patchFallbackSignalSettingsSchema,
  type FallbackSignalSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { logger } from "../../middleware/logger.js";
import {
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readResolvedFallbackSignalSettings, updateFallbackSignalSettings } from "./settings.js";
import { fallbackStatusView } from "./status.js";

/** Activity action written for every settings change. */
export const FALLBACK_SIGNAL_SETTINGS_UPDATED_ACTION = "instance.model_fallback.updated";

export function modelFallbackSignalRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/model-fallback/settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await readResolvedFallbackSignalSettings(settings, env));
  });

  router.patch(
    "/myrmidon/model-fallback/settings",
    validate(patchFallbackSignalSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as FallbackSignalSettingsPatch;
      const resolved = await updateFallbackSignalSettings(settings, patch, env);
      try {
        await logActivity(db, {
          companyId: "",
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: FALLBACK_SIGNAL_SETTINGS_UPDATED_ACTION,
          entityType: "instance_settings",
          entityId: FALLBACK_SIGNAL_SETTINGS_KEY,
          details: { settings: resolved.settings, patch },
        });
      } catch (err) {
        // The audit trail is best-effort here: the stored value is already the
        // single truth and the sweep reads it, so a failed log row must not
        // turn a successful setting change into an error response.
        logger.warn({ err }, "model fallback signal settings change was not logged");
      }
      res.json(resolved);
    },
  );

  router.get("/myrmidon/companies/:companyId/model-fallback/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const resolved = await readResolvedFallbackSignalSettings(settings, env);
    res.json(fallbackStatusView(companyId, resolved));
  });

  return router;
}