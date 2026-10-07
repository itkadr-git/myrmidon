// server/src/myrmidon/litellm-budget-sync/index.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the wiring point of the LiteLLM budget
// projection. app.ts mounts `myrmidonLitellmBudgetSyncRoutes` from here;
// server/src/index.ts starts the sweep next to startLitellmCostSweep. The
// settings PUT asks the sweep for one immediate pass through the hook the
// sweep itself registers (see sweep.ts), so a saved limit reaches LiteLLM
// within seconds of the save, not at the next tick.

import type { Db } from "@paperclipai/db";
import { isNotNull } from "drizzle-orm";
import { companies } from "@paperclipai/db";
import { myrmidonLitellmBudgetSyncRoutes } from "./routes.js";
import { startBudgetProjectionSweep, stopBudgetProjectionSweep } from "./sweep.js";

export * from "./service.js";
export {
  BUDGET_PROJECTION_SWEEP_INTERVAL_ENV,
  DEFAULT_BUDGET_PROJECTION_SWEEP_INTERVAL_SEC,
} from "./settings.js";
export { startBudgetProjectionSweep, stopBudgetProjectionSweep } from "./sweep.js";
export { myrmidonLitellmBudgetSyncRoutes } from "./routes.js";

/** The companies the sweep visits (every company row). */
async function listCompanyIds(db: Db): Promise<string[]> {
  const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
  return rows.map((row) => row.id);
}

/**
 * Startup: the sweep. A no-op while the instance names no gateway contour or
 * the company's document switch is off (both re-read live — the UI can turn
 * the projection on without a restart).
 */
export function startLitellmBudgetSync(db: Db, env: NodeJS.ProcessEnv = process.env): () => void {
  return startBudgetProjectionSweep(db, {
    env,
    ports: { listCompanyIds: (db2) => listCompanyIds(db2) },
  });
}
