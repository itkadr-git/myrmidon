// server/src/myrmidon/bot-containers/bot-image-rollout-routes.ts
//
// myrmidon(BOT-ROLLOUT): GET/PATCH /api/myrmidon/bot-image-rollout.
//
// GET reports the release bot-image rollout settings in force: each knob
// resolved env→stored-override (env is the default and the upper bound), so
// the panel can show the effective value, where it came from and the cap the
// UI must not cross. Any authenticated board member may read it. PATCH writes
// `instance_settings.general.myrmidonBotImageRollout` and is instance-admin
// only, the same rule the rest of the instance settings follow. A change
// needs no restart: the rollout script reads the row through the deploy-time
// resolution (the env stays the default and the upper bound).

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchBotImageRolloutSettingsSchema,
  resolveBotImageRolloutSettings,
  normalizeBotImageRolloutSettings,
  type BotImageRolloutSettings,
  type BotImageRolloutSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

/** Audit action for a saved rollout settings change. */
export const BOT_IMAGE_ROLLOUT_UPDATED_ACTION = "instance.bot_image_rollout.updated";

export function botImageRolloutRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/bot-image-rollout", async (req, res) => {
    assertBoardOrgAccess(req);
    const general = await settings.getGeneral();
    res.json({
      settings: normalizeBotImageRolloutSettings(general.myrmidonBotImageRollout),
      resolved: resolveBotImageRolloutSettings(process.env, general.myrmidonBotImageRollout),
    });
  });

  router.patch(
    "/myrmidon/bot-image-rollout",
    validate(patchBotImageRolloutSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as BotImageRolloutSettingsPatch;
      const general = await settings.getGeneral();
      const current = normalizeBotImageRolloutSettings(general.myrmidonBotImageRollout);
      const next: BotImageRolloutSettings = {
        botTimeoutSec: patch.botTimeoutSec === undefined ? current.botTimeoutSec : patch.botTimeoutSec,
        batchSize: patch.batchSize === undefined ? current.batchSize : patch.batchSize,
        busySoftPauseSec: patch.busySoftPauseSec === undefined ? current.busySoftPauseSec : patch.busySoftPauseSec,
      };
      await settings.updateGeneral({ myrmidonBotImageRollout: next });
      // audit like the disk-quota settings: one activity row per company
      const companyIds = await settings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: BOT_IMAGE_ROLLOUT_UPDATED_ACTION,
            entityType: "instance_settings",
            entityId: "bot-image-rollout",
            details: { previous: current, next },
          }),
        ),
      );
      res.json({
        settings: next,
        resolved: resolveBotImageRolloutSettings(process.env, next),
      });
    },
  );

  return router;
}

export function myrmidonBotImageRolloutRoutes(db: Db) {
  return botImageRolloutRoutes(db);
}
