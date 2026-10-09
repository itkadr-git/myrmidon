// server/src/myrmidon/scent/index.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the scent module — task/agent scent
// (design §2.4, §7.1 п.4a).
//
//   gateway.ts     one structured LiteLLM chat/completions call per record
//                  (json_schema response_format with additionalProperties:
//                  false; no env reads in the module — the key comes from the
//                  caller).
//   service.ts     classification + storage + the hour-budget ledger
//                  (attempts count, successes or not); the markup queue is
//                  OPEN todo tasks only (§7.1 п.4a) plus agents with empty
//                  scent_tags and non-empty capabilities.
//   create-hook.ts the pure create derivation — explicit caste kept and
//                  stamped 'manual'; scent top ≥ 0.5 → auto caste; otherwise
//                  NULL so the §2.1 chain (project default ?? company
//                  default) resolves at read time. Never writes the company
//                  default as 'auto'. Issue creation never blocks on the
//                  classifier (the scent arrives from the queue/refresh).
//   queue.ts       the markup queue runner — its OWN timer (never a
//                  heartbeat.ts pass: startup/dispatch must not wait on LLM
//                  calls).
//   routes.ts      POST …/issues/:id/scent/refresh, POST
//                  …/agents/:id/scent/refresh, GET …/swarm/scent/status.

export { classifyIssueScent, classifyAgentScent } from "./gateway.js";
export type {
  ScentGatewayDeps,
  ClassifyIssueScentInput,
  ClassifyAgentScentInput,
  ScentClassificationResult,
  AgentScentClassificationResult,
} from "./gateway.js";
export {
  createScentService,
  canSpendCall,
  scentSettingsFromGeneral,
} from "./service.js";
export type { ScentService, ScentServiceDeps, MarkupQueueSlice } from "./service.js";
export {
  deriveScentAuto,
  isUnclassifiableIssue,
} from "./create-hook.js";
export type { ScentCreateHookInput, ScentAutoResult } from "./create-hook.js";
export {
  runScentQueueTick,
  startScentQueue,
  SCENT_QUEUE_TICK_MS,
  SCENT_BASE_URL_ENV,
  SCENT_KEY_SECRET_ENV,
} from "./queue.js";
export type { ScentQueuePorts } from "./queue.js";
export { myrmidonScentRoutes } from "./routes.js";
