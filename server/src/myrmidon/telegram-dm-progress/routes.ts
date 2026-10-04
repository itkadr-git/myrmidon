// GET/PATCH /api/myrmidon/telegram-dm-progress (myrmidon DM-PROGRESS).
//
// GET reports the live-progress settings of the bridged Telegram DM status
// message in force and where each value came from (stored settings, the
// environment override, or the default); any authenticated board member may
// read it. PATCH writes `instance_settings.general.telegramDmProgress`; it is
// instance-admin only, the same rule the rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchTelegramDmProgressSchema, type TelegramDmProgressPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { TelegramDmProgressService } from "./service.js";

export function telegramDmProgressRoutes(_db: Db, service: TelegramDmProgressService) {
  const router = Router();

  router.get("/myrmidon/telegram-dm-progress", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/telegram-dm-progress", validate(patchTelegramDmProgressSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as TelegramDmProgressPatch, getActorInfo(req)));
  });

  return router;
}
