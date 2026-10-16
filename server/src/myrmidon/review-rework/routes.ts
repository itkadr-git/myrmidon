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

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchReviewReworkSettingsSchema, type ReviewReworkSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logActivity } from "../../services/activity-log.js";
import { reviewReworkSettingsService } from "./settings.js";

export function reviewReworkRoutes(db: Db) {
  const router = Router();
  const settingsService = reviewReworkSettingsService(db, {
    settings: instanceSettingsService(db),
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
  });

  router.get("/myrmidon/review-rework", async (req, res) => {
    assertBoardOrgAccess(req);
    const [settings, journal] = await Promise.all([settingsService.read(), settingsService.journal()]);
    res.json({ settings, journal });
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
