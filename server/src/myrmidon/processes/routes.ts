// GET/PATCH /api/myrmidon/processes (myrmidon PROCS-1.1, design OPE-5394 §7.2).
//
// GET reports the settings of the board processes — mode, api count, lease,
// event bus, admission store, singleton proxy — with the source of each value
// (saved here, the environment, or the default) and the mode this build
// actually honours; any authenticated board member may read it. PATCH writes
// `instance_settings.general.processes` and applies it without a restart; it is
// instance-admin only, the same rule the rest of the instance settings follow.
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { processesSettingsPatchSchema, type ProcessesSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { ProcessesSettingsService } from "./service.js";

export function myrmidonProcessesRoutes(_db: Db, service: ProcessesSettingsService) {
  const router = Router();

  router.get("/myrmidon/processes", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/processes", validate(processesSettingsPatchSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as ProcessesSettingsPatch, getActorInfo(req)));
  });

  return router;
}