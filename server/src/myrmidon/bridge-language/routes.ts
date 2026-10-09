// GET/PATCH /api/myrmidon/bridge-language (myrmidon 1.6.5-TG-LOCALE-C).
//
// GET reports the instance-wide default language of the bridged Telegram DM in
// force and where the value came from (the environment force, the stored
// instance setting, or English); any authenticated board member may read it.
// PATCH writes `instance_settings.general.bridgeLanguage`; it is
// instance-admin only, the same rule every other instance setting follows
// (agents never read or write it).

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchBridgeLanguageSchema, type PatchBridgeLanguage } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { BridgeLanguageService } from "./service.js";

export function bridgeLanguageRoutes(_db: Db, service: BridgeLanguageService) {
  const router = Router();

  router.get("/myrmidon/bridge-language", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/bridge-language", validate(patchBridgeLanguageSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as PatchBridgeLanguage, getActorInfo(req)));
  });

  return router;
}