export { default as manifest } from "./manifest.js";
export { createHindsightPlugin } from "./plugin.js";
export { resolveBank } from "./bank.js";
export { HindsightClient, formatMemories } from "./client.js";
export { runConsolidationPass } from "./consolidation.js";
export type {
  BankDocumentItem,
  BankDocumentsPage,
  BankMentalModelItem,
  BankMentalModelsPage,
  ConsolidationTriggerResult,
  AsyncOperationTicket,
} from "./client.js";
export type { FetchLike } from "./client.js";
export type { ConsolidationCheckpoint, ConsolidationPassOptions, ConsolidationPassResult } from "./consolidation.js";
