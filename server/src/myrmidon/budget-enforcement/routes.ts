// GET/PATCH /api/myrmidon/budget-enforcement (myrmidon 1.7 BUDGET-CONFIG-B).
//
// GET reports the enforcement mode in force and where it came from (the
// stored settings, the environment override, or the built-in default); any
// authenticated board member may read it. PATCH writes
// `instance_settings.general.budgetEnforcement`; it is instance-admin only,
// the same rule the rest of the instance settings follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { patchBudgetEnforcementSchema, type BudgetEnforcementPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import type { BudgetEnforcementService } from "./service.js";

export function budgetEnforcementRoutes(_db: Db, service: BudgetEnforcementService) {
  const router = Router();

  router.get("/myrmidon/budget-enforcement", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  router.patch("/myrmidon/budget-enforcement", validate(patchBudgetEnforcementSchema), async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await service.update(req.body as BudgetEnforcementPatch, getActorInfo(req)));
  });

  return router;
}
