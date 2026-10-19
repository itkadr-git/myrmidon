// GET/PATCH /api/myrmidon/behavior-settings (myrmidon 1.7, SETTINGS-TO-UI A).
//
// GET reports the effective behavior settings and where each value came from
// (the stored settings, the environment, or the built-in default); any
// authenticated board member may read the instance settings. Company settings
// (GET/PATCH .../:companyId) require company access. PATCH writes
// `instance_settings.general.behaviorSettings` (instance) or the
// company-keyed area (company), applies the new settings to the running system
// and asks for any necessary sweeps; the instance-level write is
// instance-admin only, the same rule runtime-limits follows.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { behaviorSettingRegistry, createBehaviorSettingsScopePatchSchema, type BehaviorSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import type { BehaviorSettingsService } from "./service.js";

export function behaviorSettingsRoutes(_db: Db, service: BehaviorSettingsService) {
  const router = Router();
  const instanceKeys = new Set(behaviorSettingRegistry.getInstanceKeys());
  const companyKeys = new Set(behaviorSettingRegistry.getAll().filter((setting) => setting.scope === "company").map((setting) => setting.key));

  // GET the instance-level
  router.get("/myrmidon/behavior-settings", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  // Update the instance-level behavior settings
  router.patch("/myrmidon/behavior-settings", validate(createBehaviorSettingsScopePatchSchema("instance")), async (req, res) => {
    assertInstanceAdmin(req);
    const patch = Object.fromEntries(Object.entries(req.body as BehaviorSettingsPatch).filter(([key]) => instanceKeys.has(key))) as BehaviorSettingsPatch;
    res.json(await service.updateInstance(patch, getActorInfo(req)));
  });

  // Read the company-level behavior settings
  router.get("/myrmidon/behavior-settings/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.readCompany(companyId));
  });

  // Update the company-level behavior settings
  router.patch("/myrmidon/behavior-settings/:companyId", validate(createBehaviorSettingsScopePatchSchema("company")), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const patch = Object.fromEntries(Object.entries(req.body as BehaviorSettingsPatch).filter(([key]) => companyKeys.has(key))) as BehaviorSettingsPatch;
    res.json(await service.updateCompany(companyId, patch, getActorInfo(req)));
  });

  return router;
}
