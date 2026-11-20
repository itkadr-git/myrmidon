// GET/PATCH /api/myrmidon/run-priority (myrmidon 1.6.5, RUN-PRIORITY A).
//
// GET reports the effective settings and where they came from (the stored
// settings, the environment, or the built-in defaults); any authenticated
// board member may read it. PATCH writes `instance_settings.general.runPriority`,
// applies the new settings to the live sweeps and asks for a queued-run sweep;
// it is instance-admin only, the same rule the rest of the instance settings
// and the runtime-limits route follow.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { patchRunPrioritySchema, runPrioritySettingsSchema, type RunPriorityPatch } from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { RunPriorityService } from "./service.js";

export function runPriorityRoutes(_db: Db, service: RunPriorityService) {
  const router = Router();

  router.get("/myrmidon/run-priority/company/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.readCompany(companyId));
  });

  router.patch("/myrmidon/run-priority/company/:companyId", validate(runPrioritySettingsSchema.pick({ currentRelease: true, strictReleaseFocus: true })), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertInstanceAdmin(req);
    await service.updateCompany(companyId, req.body, getActorInfo(req));
    res.json(await service.readCompany(companyId));
  });

  router.get("/myrmidon/run-priority", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/run-priority", validate(patchRunPrioritySchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as RunPriorityPatch, getActorInfo(req)));
  });

  return router;
}
