// GET/PATCH /api/myrmidon/bot-lsp (myrmidon BOT-LSP-DEFAULTS).
//
// GET reports the stored language-server policy, the values in force and the
// mode each container bot resolves to. PATCH writes
// `instance_settings.general.botLsp`; instance-admin only, like the rest of
// the instance settings. No apply step: the profile compiler re-reads the row
// on every reconcile tick, and the reconciler applies the changed config.yaml
// with the bot paused.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchBotLspSettingsSchema, type BotLspSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { BotLspService } from "./service.js";

export function botLspRoutes(_db: Db, service: BotLspService) {
  const router = Router();

  router.get("/myrmidon/bot-lsp", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/bot-lsp", validate(patchBotLspSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as BotLspSettingsPatch, getActorInfo(req)));
  });

  return router;
}
