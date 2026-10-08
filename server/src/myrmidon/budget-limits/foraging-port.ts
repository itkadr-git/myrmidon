// server/src/myrmidon/budget-limits/foraging-port.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): the foraging budget view port — the foraging
// level's "spent in period" is the FORAGING sweep's own budget state (the
// OPE-3964 pass budget is absorbed by this level's limit).
//
// The port reads through the foraging service so the limit view and the
// Foraging screen can never disagree. A failure is logged and degrades to
// spentCents 0 — the limit view must never break because a sibling feature's
// state read failed.

import type { Db } from "@paperclipai/db";
import { foragingWiring } from "../foraging/index.js";
import { logger } from "../../middleware/logger.js";

/** The budget-state view the foraging level needs. */
export function createForagingBudgetStatePort(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): (companyId: string) => Promise<{ spentCents: number }> {
  return async (companyId: string) => {
    try {
      const { service } = foragingWiring(db, env);
      const state = await service.budgetState(companyId);
      return { spentCents: state.spentCents };
    } catch (err) {
      logger.warn({ err, companyId }, "budget-limits: foraging budget state unavailable");
      return { spentCents: 0 };
    }
  };
}
