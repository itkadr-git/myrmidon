// server/src/myrmidon/bot-containers/bot-disk-quota-routes.ts
//
// myrmidon(1.6.1-BOT-DISK-C): GET/PATCH /api/myrmidon/bot-disk-quota.
//
// GET reports the quota settings in force and what the last sweep measured; any
// authenticated board member may read it, and the route never walks a disk.
// PATCH writes `instance_settings.general.botDiskQuota` and is instance-admin
// only, the same rule the rest of the instance settings follow. A change needs
// no restart: the sweep and the admission check both read the row at use time.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  normalizeBotDiskQuotaSettings,
  patchBotDiskQuotaSettingsSchema,
  type BotDiskQuotaSettings,
  type BotDiskQuotaSettingsPatch,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { botDiskQuotaRuntime } from "./bot-disk-quota-runtime.js";

/** Audit action for a saved quota (mirrors BOT_DISK_UPDATED_ACTION of part A). */
export const BOT_DISK_QUOTA_UPDATED_ACTION = "instance.bot_disk_quota.updated";

export function botDiskQuotaRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);
  const runtime = botDiskQuotaRuntime(db);

  router.get("/myrmidon/bot-disk-quota", async (req, res) => {
    assertBoardOrgAccess(req);
    const general = await settings.getGeneral();
    res.json({
      settings: normalizeBotDiskQuotaSettings(general.botDiskQuota),
      lastSweep: runtime.sweep.lastResult(),
    });
  });

  router.patch(
    "/myrmidon/bot-disk-quota",
    validate(patchBotDiskQuotaSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      const patch = req.body as BotDiskQuotaSettingsPatch;
      const general = await settings.getGeneral();
      const current = normalizeBotDiskQuotaSettings(general.botDiskQuota);
      const next: BotDiskQuotaSettings = {
        defaultQuotaMb: patch.defaultQuotaMb === undefined ? current.defaultQuotaMb : patch.defaultQuotaMb,
        perCaste: patch.perCaste ?? current.perCaste,
        perAgent: patch.perAgent ?? current.perAgent,
      };
      await settings.updateGeneral({ botDiskQuota: next });
      // audit like BOT-DISK-A: one activity row per company, same action shape
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
            action: BOT_DISK_QUOTA_UPDATED_ACTION,
            entityType: "instance_settings",
            entityId: "bot-disk-quota",
            details: { previous: current, next },
          }),
        ),
      );
      res.json({ settings: next, lastSweep: runtime.sweep.lastResult() });
    },
  );

  return router;
}

export function myrmidonBotDiskQuotaRoutes(db: Db) {
  return botDiskQuotaRoutes(db);
}
