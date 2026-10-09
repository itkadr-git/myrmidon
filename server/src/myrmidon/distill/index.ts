// server/src/myrmidon/distill/index.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): entry point of the distiller module.
// The pass (service.ts) turns tasks closed in the window into knowledge
// suggestions; the skill `knowledge-distill` (curator cast) writes the final
// proposal texts. The module replaces the `paperclip-distill` plugin routine
// once K-6 moves the knowledge over.

export * from "./domain.js";
export {
  DISTILL_SETTINGS_KEY,
  resolveDistillSettings,
  mergeDistillSettings,
  type DistillSettings,
  type ResolvedDistillSettings,
} from "./settings.js";
export {
  buildDistillUserPrompt,
  createDistillGatewayCall,
  parseDistillAnswer,
  DISTILL_SYSTEM_PROMPT,
  type DistillModelCall,
  type DistillModelProposal,
} from "./model.js";
export { selectClosedTasks, taskIsLife, passWindow, type DistillRawTask, type DistillRawWindow } from "./raw.js";
export { runDistillPass, type DistillPassReport, type DistillServiceOptions } from "./service.js";
export { startDistillSweep, stopDistillSweep, type DistillSweepOptions } from "./startup.js";
