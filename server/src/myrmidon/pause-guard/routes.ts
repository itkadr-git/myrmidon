// GET/PATCH /api/myrmidon/pause-guard (myrmidon 1.6.5 PAUSE-GUARD).
//
// GET reports the effective settings and where each value came from (the
// stored settings, the environment, or the built-in default); any
// authenticated board member may read it. PATCH writes
// `instance_settings.general.pauseGuard` and asks the guard to run its next
// pass at the next scheduler tick; it is instance-admin only, the same rule
// the rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchPauseGuardSettingsSchema, type PauseGuardSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { PauseGuardService } from "./service.js";

export function pauseGuardRoutes(_db: Db, service: PauseGuardService) {
  const router = Router();

  router.get("/myrmidon/pause-guard", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/pause-guard", validate(patchPauseGuardSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as PauseGuardSettingsPatch, getActorInfo(req)));
  });

  return router;
}