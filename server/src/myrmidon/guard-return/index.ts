// server/src/myrmidon/guard-return/index.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Entry point for guard-return subsystem.

import type { Db } from "@myrmidon/db";
import { logger as rootLogger } from "../../middleware/logger.js";
import { createGuardReturnSweep, type GuardReturnSweepDeps } from "./sweep.js";

export * from "./domain.js";
export * from "./sweep.js";
export * from "./guard.js";
export * from "./alert.js";

export interface GuardReturnSchedulerDeps {
  db: Db;
  wakeup: (agentId: string, options: Record<string, unknown>) => Promise<unknown>;
  track?: (work: Promise<unknown>) => void;
  logger?: typeof rootLogger;
}

export function createGuardReturnScheduler(deps: GuardReturnSchedulerDeps) {
  const sweeper = createGuardReturnSweep({
    db: deps.db,
    wakeup: deps.wakeup,
    logger: deps.logger,
  });

  const track = deps.track ?? ((work) => { void work; });

  function scheduleGuardReturnSweep() {
    track(
      sweeper.sweep(new Date()).catch((err) => {
        (deps.logger ?? rootLogger).error({ err }, "guard-return sweep failed");
      }),
    );
  }

  return {
    scheduleGuardReturnSweep,
    sweep: (now?: Date, options?: { force?: boolean }) => sweeper.sweep(now, options),
  };
}
