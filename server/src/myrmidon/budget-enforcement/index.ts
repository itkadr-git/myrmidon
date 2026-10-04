// Budget enforcement mode (myrmidon 1.7 BUDGET-CONFIG-B) entry point.
//
// Router for app.ts: GET/PATCH /api/myrmidon/budget-enforcement. The mode is
// read from the instance settings at evaluation time — there is no startup
// apply step and no in-process cache, so nothing else needs wiring here.

import type { Db } from "@paperclipai/db";
import { budgetEnforcementRoutes } from "./routes.js";
import { budgetEnforcementService } from "./service.js";

export {
  budgetEnforcementService,
  BUDGET_ENFORCEMENT_ACTION,
  type BudgetEnforcementActor,
  type BudgetEnforcementService,
  type BudgetEnforcementView,
} from "./service.js";
export {
  readBudgetEnforcement,
  preserveBudgetEnforcementGeneralKey,
  BUDGET_ENFORCEMENT_MODE_ENV,
  BUDGET_ENFORCEMENT_SETTINGS_KEY,
} from "./settings.js";

/** Router for app.ts: GET/PATCH /api/myrmidon/budget-enforcement. */
export function myrmidonBudgetEnforcementRoutes(db: Db) {
  return budgetEnforcementRoutes(db, budgetEnforcementService(db));
}
