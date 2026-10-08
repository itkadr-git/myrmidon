// GET/PATCH /api/myrmidon/foraging/idle-gate (myrmidon 1.6.3 FORAGING-IDLE-GATE).
//
// GET reports the toggle in force and where it came from (the stored
// settings, the environment override, or the built-in default); any
// authenticated board member may read it. PATCH writes
// `instance_settings.general.foragingIdleGate`; it is instance-admin only,
// the same rule the rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchForagingIdleGateSchema, type ForagingIdleGatePatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { ForagingIdleGateService } from "./idle-gate-settings.js";

export function foragingIdleGateRoutes(_db: Db, service: ForagingIdleGateService) {
  const router = Router();

  router.get("/myrmidon/foraging/idle-gate", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/foraging/idle-gate", validate(patchForagingIdleGateSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as ForagingIdleGatePatch, getActorInfo(req)));
  });

  return router;
}
