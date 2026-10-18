// server/src/myrmidon/budget-limits/index.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the wiring point of the per-level spend
// limits. app.ts mounts `budgetLimitsRoutes` from here. The shared contract
// (levels, periods, modes, signal-only resolution, window math) lives in
// `@paperclipai/shared` so a later UI part reads the same decisions this
// module serves.

import type { Db } from "@paperclipai/db";
import { budgetLimitsRoutes } from "./routes.js";
import { createForagingBudgetStatePort } from "./foraging-port.js";

export * from "./settings.js";
export { createBudgetLimitStore, validateBudgetLimitRef } from "./store.js";
export type { BudgetLimitStore, BudgetLimitRow, BudgetLimitActor, BudgetLimitAction } from "./store.js";
export { computeBudgetLimitUsage, issueIdsOfRole } from "./usage.js";
export type { BudgetLimitUsage, BudgetLimitUsageDeps } from "./usage.js";
export { budgetLimitsRoutes } from "./routes.js";
export type { BudgetLimitRoutesDeps } from "./routes.js";

/** Router for app.ts: limits, journal, usage and the signal-only flag. */
export function myrmidonBudgetLimitsRoutes(db: Db) {
  return budgetLimitsRoutes(db, {
    foragingBudgetState: createForagingBudgetStatePort(db),
  });
}
