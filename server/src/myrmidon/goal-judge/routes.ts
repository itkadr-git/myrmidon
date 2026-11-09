// server/src/myrmidon/goal-judge/routes.ts
//
// myrmidon(1.7-GOAL-JUDGE): instance settings API for the goal judge.
//
// - GET   /api/myrmidon/goal-judge — stored settings plus change journal; any board member reads.
// - PATCH /api/myrmidon/goal-judge — configure switch, model, provider; instance admin writes.
//
// Patterned after review-rework (server/src/myrmidon/review-rework/routes.ts).

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logActivity } from "../../services/activity-log.js";
import {
  goalJudgeSettingsService,
  patchGoalJudgeSettingsSchema,
  type GoalJudgeSettingsPatch,
  type GoalJudgeSettingsService,
} from "./settings.js";

export function createGoalJudgeRoutesWithService(settingsService: GoalJudgeSettingsService): Router {
  const router = Router();

  router.get("/myrmidon/goal-judge", async (req, res) => {
    assertBoardOrgAccess(req);
    const [settings, journal] = await Promise.all([
      settingsService.read(),
      settingsService.journal(),
    ]);
    res.json({ settings, journal });
  });

  router.patch(
    "/myrmidon/goal-judge",
    validate(patchGoalJudgeSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as GoalJudgeSettingsPatch;
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

export function goalJudgeRoutes(db: Db, customSettingsService?: GoalJudgeSettingsService): Router {
  const settingsSvc =
    customSettingsService ??
    goalJudgeSettingsService(db, {
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

  return createGoalJudgeRoutesWithService(settingsSvc);
}

export const myrmidonGoalJudgeRoutes = goalJudgeRoutes;
