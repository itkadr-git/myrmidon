// server/src/myrmidon/prompt-budget-advice/index.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET C): the wiring point of the prompt-budget advice.
//
// app.ts mounts `myrmidonPromptBudgetAdviceRoutes` from here. The generator, the
// read port and the deep-task builder are exported for tests and for a future
// re-point of the port at the prompt-budget status service of the same release.
// Nothing is scheduled: the advice is computed on request, the deep pass is
// started by the operator's button.

import type { Db } from "@paperclipai/db";
import { promptBudgetAdviceRoutes } from "./routes.js";

export * from "./advice.js";
export * from "./deep.js";
export * from "./settings.js";
export * from "./source.js";
export { promptBudgetAdviceRoutes } from "./routes.js";
export type {
  CreatedDeepAnalysisTask,
  PromptBudgetAdviceDeps,
} from "./routes.js";

/** Router for app.ts: static advice and the deep-analysis hand-off. */
export function myrmidonPromptBudgetAdviceRoutes(db: Db) {
  return promptBudgetAdviceRoutes(db);
}