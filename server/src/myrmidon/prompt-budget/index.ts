// server/src/myrmidon/prompt-budget/index.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the wiring point of the prompt-budget
// thresholds.
//
// app.ts mounts `myrmidonPromptBudgetRoutes` from here; the startup in
// index.ts ticks the sweeper on the heartbeat scheduler (the same place the
// wip-limit sweep lives). The shared contract (settings shape, level resolver,
// status rows) lives in `@paperclipai/shared` so the UI and the sibling parts
// of this release read the same decisions this module enforces.

import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { promptBudgetRoutes } from "./routes.js";
import { createPromptBudgetSweeper, type PromptBudgetSweeper } from "./sweep.js";

export * from "./status.js";
export * from "./attention.js";
export * from "./signal.js";
export * from "./notice.js";
export * from "./settings.js";
export { promptBudgetRoutes } from "./routes.js";
export { createPromptBudgetSweeper } from "./sweep.js";
export type {
  PromptBudgetSweeper,
  PromptBudgetSweeperDeps,
  PromptBudgetSweepResult,
} from "./sweep.js";

/** Router for app.ts: settings and status over the fixed contract. */
export function myrmidonPromptBudgetRoutes(db: Db) {
  return promptBudgetRoutes(db);
}

/**
 * The sweeper the startup ticks.
 *
 * myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): the sweeper takes no comment port any
 * more. Its signal is the recorded row the attention feed renders, so the
 * issue service is no longer part of this module's wiring.
 */
export function buildPromptBudgetSweeper(db: Db): PromptBudgetSweeper {
  return createPromptBudgetSweeper({
    db,
    settings: instanceSettingsService(db),
  });
}
