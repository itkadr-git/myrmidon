// GET/PATCH /api/myrmidon/run-stall (myrmidon RUN-STALL-SETTINGS, 1.6.5).
//
// GET reports the effective run stall detection settings and where each value
// came from (the stored settings, the environment, or the built-in default);
// any authenticated board member may read it. PATCH writes
// `instance_settings.general.runStall` and applies the new settings to the
// running sweep; it is instance-admin only, the same rule the rest of the
// instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchRunStallSchema, type RunStallPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { RunStallService } from "./settings-service.js";

export function runStallRoutes(_db: Db, service: RunStallService) {
  const router = Router();

  router.get("/myrmidon/run-stall", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/run-stall", validate(patchRunStallSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as RunStallPatch, getActorInfo(req)));
  });

  return router;
}
