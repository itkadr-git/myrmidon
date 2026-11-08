// myrmidon(REVIEW-REWORK): the settings API of the review-return loop.
//
// - GET   /api/myrmidon/review-rework — the stored settings plus the change
//   journal; any board member reads.
// - PATCH /api/myrmidon/review-rework — change the switch or the executor the
//   rework falls to; instance-admin writes. The sweep re-reads the row on
//   every pass, so a change applies without a restart.
//
// The routes are instance-level (the settings are stored on the instance, like
// the swarm-claim pilot's), under /api/myrmidon/ so they cannot collide with
// future vendor paths.
//
// 1.6.7 (REVIEW-REWORK-SETTINGS-500): the audit seam is injected (one
// `instance.review_rework.updated` row per company over real ids) so a PATCH
// returns 200 — the old inline seam wrote an empty company_id and died in
// persistActivity after the settings had already been saved. The service is a
// parameter (the workspace-hygiene rule) so the routes can be tested over the
// real service with fake ports.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  MAX_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
  MIN_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
  patchReviewReworkSettingsSchema,
  type ReviewReworkSettingsPatch,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logActivity } from "../../services/activity-log.js";
import { reviewReworkSettingsService, type ReviewReworkSettingsService } from "./settings.js";
import { REVIEW_REWORK_SWEEP_INTERVAL_SEC_ENV } from "./sweep.js";

export function reviewReworkRoutes(db: Db, service?: ReviewReworkSettingsService) {
  const router = Router();
  const settings = instanceSettingsService(db);
  const settingsService =
    service ??
    reviewReworkSettingsService(db, {
      settings,
      activity: {
        listCompanyIds: () => settings.listCompanyIds(),
        logActivity: async (input) => {
          await logActivity(db, {
            companyId: input.companyId,
            actorType: input.actorType as "user" | "agent" | "system",
            actorId: input.actorId,
            action: input.action,
            entityType: input.entityType as "instance_settings",
            entityId: input.entityId,
            details: input.details,
          });
        },
      },
    });

  router.get("/myrmidon/review-rework", async (req, res) => {
    assertBoardOrgAccess(req);
    const [settings, journal] = await Promise.all([settingsService.read(), settingsService.journal()]);
    // myrmidon(OPE-12397): the panel shows where the sweep interval is in
    // force from; a set MYRMIDON_REVIEW_REWORK_SWEEP_INTERVAL_SEC forces the
    // value and the input stays read-only (the LiteLlm budget panel's rule).
    const sweepIntervalEnvRaw = process.env[REVIEW_REWORK_SWEEP_INTERVAL_SEC_ENV]?.trim();
    const sweepIntervalEnvValue = sweepIntervalEnvRaw ? Number(sweepIntervalEnvRaw) : NaN;
    const envForced =
      sweepIntervalEnvRaw !== undefined &&
      Number.isInteger(sweepIntervalEnvValue) &&
      sweepIntervalEnvValue >= MIN_REVIEW_REWORK_SWEEP_INTERVAL_SEC &&
      sweepIntervalEnvValue <= MAX_REVIEW_REWORK_SWEEP_INTERVAL_SEC;
    res.json({
      settings,
      journal,
      sweepIntervalSource: envForced ? "env" : "settings",
      sweepIntervalEnvName: envForced ? REVIEW_REWORK_SWEEP_INTERVAL_SEC_ENV : "",
    });
  });

  router.patch(
    "/myrmidon/review-rework",
    validate(patchReviewReworkSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as ReviewReworkSettingsPatch;
      const settings = await settingsService.update(patch, {
        actorType: actor.actorType,
        actorId: actor.actorId,
      });
      const journal = await settingsService.journal();
      res.json({ settings, journal });
    },
  );

  return router;
}
