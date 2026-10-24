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
import type { Db } from "@myrmidon/db";
import {
  behaviorSettingRegistry,
  createBehaviorSettingsPatchSchema,
  type BehaviorSettingsPatch,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import type { BehaviorSettingsService } from "./service.js";

export function behaviorSettingsRoutes(_db: Db, service: BehaviorSettingsService) {
  const router = Router();

  // Read definitions / metadata of all settings
  router.get("/myrmidon/behavior-settings/definitions", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(
      behaviorSettingRegistry.getAll().map((def) => ({
        key: def.key,
        envName: def.envName,
        default: def.default,
        scope: def.scope,
        section: def.section,
        valueType: def.valueType,
        description: def.description,
      })),
    );
  });

  // Read a single setting by key
  router.get("/myrmidon/behavior-settings/key/:key", async (req, res) => {
    assertBoardOrgAccess(req);
    const key = req.params.key as string;
    const def = behaviorSettingRegistry.get(key);
    if (!def) {
      res.status(404).json({ error: `Unknown setting key: '${key}'` });
      return;
    }
    const view = await service.read();
    res.json({
      key,
      value: view.settings[key],
      source: view.sources[key],
      definition: {
        envName: def.envName,
        default: def.default,
        scope: def.scope,
        section: def.section,
        valueType: def.valueType,
        description: def.description,
      },
    });
  });

  // Read the instance-level behavior settings (all or ?key=...)
  router.get("/myrmidon/behavior-settings", async (req, res) => {
    assertBoardOrgAccess(req);
    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    const view = await service.read();
    if (key) {
      const def = behaviorSettingRegistry.get(key);
      if (!def || !(key in view.settings)) {
        res.status(404).json({ error: `Unknown setting key: '${key}'` });
        return;
      }
      res.json({
        key,
        value: view.settings[key],
        source: view.sources[key],
        definition: {
          envName: def.envName,
          default: def.default,
          scope: def.scope,
          section: def.section,
          valueType: def.valueType,
          description: def.description,
        },
      });
      return;
    }
    res.json(view);
  });

  // Update the instance-level behavior settings
  router.patch("/myrmidon/behavior-settings", validate(createBehaviorSettingsPatchSchema()), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.updateInstance(req.body as BehaviorSettingsPatch, getActorInfo(req)));
  });

  router.put("/myrmidon/behavior-settings", validate(createBehaviorSettingsPatchSchema()), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.updateInstance(req.body as BehaviorSettingsPatch, getActorInfo(req)));
  });

  // Read company-level settings by /company/:companyId
  router.get("/myrmidon/behavior-settings/company/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const view = await service.readCompany(companyId);
    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    if (key) {
      const def = behaviorSettingRegistry.get(key);
      if (!def || !(key in view.settings)) {
        res.status(404).json({ error: `Unknown setting key: '${key}'` });
        return;
      }
      res.json({
        key,
        value: view.settings[key],
        source: view.sources[key],
      });
      return;
    }
    res.json(view);
  });

  router.patch("/myrmidon/behavior-settings/company/:companyId", validate(createBehaviorSettingsPatchSchema()), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.updateCompany(companyId, req.body as BehaviorSettingsPatch, getActorInfo(req)));
  });

  // Read the company-level behavior settings (legacy /:companyId)
  router.get("/myrmidon/behavior-settings/:companyId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const view = await service.readCompany(companyId);
    const key = typeof req.query.key === "string" ? req.query.key : undefined;
    if (key) {
      const def = behaviorSettingRegistry.get(key);
      if (!def || !(key in view.settings)) {
        res.status(404).json({ error: `Unknown setting key: '${key}'` });
        return;
      }
      res.json({
        key,
        value: view.settings[key],
        source: view.sources[key],
      });
      return;
    }
    res.json(view);
  });

  // Update the company-level behavior settings (legacy /:companyId)
  router.patch("/myrmidon/behavior-settings/:companyId", validate(createBehaviorSettingsPatchSchema()), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.updateCompany(companyId, req.body as BehaviorSettingsPatch, getActorInfo(req)));
  });

  return router;
}
