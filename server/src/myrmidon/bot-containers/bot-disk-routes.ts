// GET/PATCH /api/myrmidon/bot-disk (myrmidon BOT-DISK-A).
//
// GET reports the effective bot draft-directory lifecycle settings and where
// each value came from (the stored settings, the environment, or the built-in
// default); any authenticated board member may read it. PATCH writes
// `instance_settings.general.botDisk` and records the change in the activity
// log; it is instance-admin only, the same rule the runtime limits and the
// rest of the instance settings follow. The sweep re-reads the row on every
// maintenance tick, so no restart is needed.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchBotDiskSettingsSchema, type BotDiskSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { botDiskService, type BotDiskService } from "./bot-disk-service.js";

export function botDiskRoutes(_db: Db, service: BotDiskService) {
  const router = Router();

  router.get("/myrmidon/bot-disk", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/bot-disk", validate(patchBotDiskSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as BotDiskSettingsPatch, getActorInfo(req)));
  });

  return router;
}

/** Router for app.ts, mounted under /api: GET/PATCH /api/myrmidon/bot-disk. */
export function myrmidonBotDiskLifecycleRoutes(db: Db) {
  return botDiskRoutes(db, botDiskService(db));
}
