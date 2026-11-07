/**
 * tokens-trace — domain types for per-LLM-call token tracing (OPE-10727).
 *
 * The trace rows themselves live in `llm_call_traces` (see
 * packages/db/src/schema/llm_call_traces.ts). This module defines the
 * per-call input DTO the adapter emits, the persistence logic, and the
 * read-side aggregates used by the acceptance queries.
 *
 * DreamTeam §16 (span llm) analogue: we keep `tools_rev`, section sizes,
 * usage, cost — never the message text.
 */
import { z } from "zod";

/** Per-section size breakdown of one LLM call's request. */
export const traceSectionSizesSchema = z.object({
  systemChars: z.number().int().nonnegative().optional(),
  systemTokens: z.number().int().nonnegative().optional(),
  toolsChars: z.number().int().nonnegative().optional(),
  toolsTokens: z.number().int().nonnegative().optional(),
  wakeChars: z.number().int().nonnegative().optional(),
  wakeTokens: z.number().int().nonnegative().optional(),
  historyChars: z.number().int().nonnegative().optional(),
  historyTokens: z.number().int().nonnegative().optional(),
  toolResultsChars: z.number().int().nonnegative().optional(),
  toolResultsTokens: z.number().int().nonnegative().optional(),
  totalChars: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type TraceSectionSizes = z.infer<typeof traceSectionSizesSchema>;

/** Usage reported by the provider for a single LLM call. */
export const traceUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  cachedPromptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  costMicroUsd: z.number().int().nonnegative().optional(),
});
export type TraceUsage = z.infer<typeof traceUsageSchema>;

/**
 * One LLM call observed by the gateway adapter. The adapter emits this on
 * every model call (success or failure after provider response). `callIndex`
 * orders multiple calls within the same heartbeat run.
 */
export const llmCallTraceInputSchema = z.object({
  version: z.literal(1).default(1),
  callIndex: z.number().int().nonnegative().default(0),
  /** Langfuse ids when the gateway propagated them (null otherwise). */
  langfuseTraceId: z.string().max(256).nullable().optional(),
  langfuseObservationId: z.string().max(256).nullable().optional(),
  litellmRequestId: z.string().max(256).nullable().optional(),
  provider: z.string().max(128).nullable().optional(),
  model: z.string().max(256).nullable().optional(),
  /** SHA-256 hex of the canonicalised tool schema set (tools_rev). */
  toolsRev: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .optional(),
  toolCount: z.number().int().nonnegative().optional(),
  sections: traceSectionSizesSchema.default({}),
  usage: traceUsageSchema.default({
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
  }),
  compacted: z.boolean().default(false),
  preCompactChars: z.number().int().nonnegative().nullable().optional(),
  postCompactChars: z.number().int().nonnegative().nullable().optional(),
});
export type LlmCallTraceInput = z.infer<typeof llmCallTraceInputSchema>;

/**
 * Shape of `resultJson.llmCallTraces` the gateway adapter hands back to the
 * server. The server persists each entry as a `llm_call_traces` row.
 */
export const llmCallTracesResultSchema = z.object({
  version: z.literal(1).default(1),
  calls: z.array(llmCallTraceInputSchema).max(512).default([]),
});
export type LlmCallTracesResult = z.infer<typeof llmCallTracesResultSchema>;

/**
 * Aggregate for one agent over a time window — acceptance query #1.
 * `cacheShare` = SUM(cachedPromptTokens) / SUM(promptTokens).
 */
export interface AgentTraceAggregate {
  agentId: string;
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  /** Cache share in [0, 1]; null when no prompt tokens recorded. */
  cacheShare: number | null;
  sections: {
    systemTokens: number;
    toolsTokens: number;
    wakeTokens: number;
    historyTokens: number;
    toolResultsTokens: number;
    totalTokens: number;
  };
  /** Section shares as fractions of totalTokens; null-safe. */
  sectionShares: {
    system: number | null;
    tools: number | null;
    wake: number | null;
    history: number | null;
    toolResults: number | null;
  };
  byModel: Array<{
    model: string;
    calls: number;
    promptTokens: number;
    cachedPromptTokens: number;
  }>;
  byToolsRev: Array<{
    toolsRev: string;
    calls: number;
  }>;
}

/** Aggregate for one agent over a time window — acceptance query #2. */
export interface KeySpendAggregate {
  /** Agent id attributed by the gateway key. */
  agentId: string;
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
  cacheShare: number | null;
}
