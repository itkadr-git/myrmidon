// server/src/myrmidon/budget-limits/index.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the wiring point of the per-level spend
// limits. app.ts mounts `budgetLimitsRoutes` from here. The shared contract
// (levels, periods, modes, signal-only resolution, window math) lives in
// `@myrmidon/shared` so a later UI part reads the same decisions this
// module serves.

import type { Db } from "@myrmidon/db";
import { issues } from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { budgetLimitsRoutes } from "./routes.js";
import { createForagingBudgetStatePort } from "./foraging-port.js";

export * from "./settings.js";
export { createBudgetLimitStore, resolveEffectiveBudgetLimit, validateBudgetLimitRef } from "./store.js";
export type { BudgetLimitStore, BudgetLimitRow, BudgetLimitActor, BudgetLimitAction } from "./store.js";
export { computeBudgetLimitUsage, issueIdsOfRole } from "./usage.js";
export type { BudgetLimitUsage, BudgetLimitUsageDeps } from "./usage.js";
export { decideBudgetLimitAdmission, evaluateBudgetLimitAdmission } from "./admission.js";
export type {
  BudgetLimitAdmissionBlock,
  BudgetLimitAdmissionDecision,
  BudgetLimitAdmissionInput,
  BudgetLimitAdmissionPorts,
} from "./admission.js";
export { budgetLimitsRoutes } from "./routes.js";
export type { BudgetLimitRoutesDeps } from "./routes.js";
export { buildBudgetConfig } from "@myrmidon/shared";
export type { BudgetConfigView, BudgetConfigLevelView, BudgetConfigLevel, BudgetConfigInput } from "@myrmidon/shared";

/** Router for app.ts: limits, journal, usage and the signal-only flag. */
export function myrmidonBudgetLimitsRoutes(db: Db) {
  return budgetLimitsRoutes(db, {
    foragingBudgetState: createForagingBudgetStatePort(db),
    resolveIssue: async (companyId, issueId) => {
      const [row] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      return row ?? null;
    },
  });
}
