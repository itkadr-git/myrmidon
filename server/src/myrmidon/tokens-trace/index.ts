/**
 * tokens-trace — public surface (OPE-10727).
 */
export {
  llmCallTraceInputSchema,
  llmCallTracesResultSchema,
  traceSectionSizesSchema,
  traceUsageSchema,
  type AgentTraceAggregate,
  type KeySpendAggregate,
  type LlmCallTraceInput,
  type LlmCallTracesResult,
  type TraceSectionSizes,
  type TraceUsage,
} from "./domain.js";
export {
  aggregateByAgent,
  inferFromRunUsage,
  persistLlmCallTraces,
  reconcilePerCall,
  reconcileWithSpendLogs,
} from "./store.js";
export type { PerCallReconcileRow } from "./store.js";
export {
  DEFAULT_PER_CALL_TOLERANCE,
  findPerCallMismatches,
} from "./per-call-reconcile.js";
export type {
  PerCallMismatch,
  PerCallMismatchKind,
  PerCallPromptRow,
} from "./per-call-reconcile.js";
export { buildTokensTraceRoutes, TOKENS_TRACE_API_BASE } from "./routes.js";
