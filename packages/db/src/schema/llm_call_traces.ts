import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * llm_call_traces — per-LLM-call token trace (OPE-10727 TOKENS-TRACE).
 *
 * Stores metadata-only traces for every LLM call made by a bot runtime
 * (hermes gateway / bot-runtime). No request content is persisted — only
 * sizes (chars/tokens), hashes, and provider usage numbers. This is the
 * substrate for the TOKENS-WAKE-DELTA / TOKENS-TOOLS-STABLE /
 * TOKENS-TOOL-OUTPUT measurements.
 *
 * DreamTeam §16 (span llm) analogue: messages → section sizes, tools_rev,
 * usage, cost. We persist the span summary, not the messages themselves.
 */
export const llmCallTraces = pgTable(
  "llm_call_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    // The heartbeat run that issued this LLM call. A single run may make
    // several model calls (multi-turn loop within one wake).
    heartbeatRunId: uuid("heartbeat_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    // The issue the run was scoped to, denormalised for cheap filtering.
    issueId: uuid("issue_id"),
    // Provider-reported identifiers (Langfuse trace/observation ids when
    // available). Not unique: a single provider call may fan out to
    // multiple fallback attempts recorded as separate rows.
    langfuseTraceId: text("langfuse_trace_id"),
    langfuseObservationId: text("langfuse_observation_id"),
    litellmRequestId: text("litellm_request_id"),
    // Provider + model as reported by the gateway payload (post-fallback).
    provider: text("provider"),
    model: text("model"),
    // Hash of the tool schema set sent with this call (tools_rev in
    // DreamTeam terms). Stable for the same set of tool names + schemas;
    // changes when the gateway adds/removes/reorders tools or updates a
    // schema. Computed client-side (adapter) and verified server-side.
    toolsRev: text("tools_rev"),
    toolCount: integer("tool_count"),
    // Section sizes of the request, measured in UTF-8 bytes and estimated
    // tokens. Sections follow the OPE-9723 split:
    //   - systemChars/systemTokens: instructions bundle + card instructions
    //   - toolsChars/toolsTokens: JSON-serialised tool schemas
    //   - wakeChars/wakeTokens: wake input / user message
    //   - historyChars/historyTokens: restored central-history block
    //   - toolResultsChars/toolResultsTokens: in-context tool outputs
    //   - totalChars/totalTokens: the wire request body
    // Only sizes are stored; the source text is never persisted here.
    systemChars: bigint("system_chars", { mode: "number" }),
    systemTokens: integer("system_tokens"),
    toolsChars: bigint("tools_chars", { mode: "number" }),
    toolsTokens: integer("tools_tokens"),
    wakeChars: bigint("wake_chars", { mode: "number" }),
    wakeTokens: integer("wake_tokens"),
    historyChars: bigint("history_chars", { mode: "number" }),
    historyTokens: integer("history_tokens"),
    toolResultsChars: bigint("tool_results_chars", { mode: "number" }),
    toolResultsTokens: integer("tool_results_tokens"),
    totalChars: bigint("total_chars", { mode: "number" }),
    totalTokens: integer("total_tokens"),
    // Provider-reported usage for the call. `promptTokens` includes cached
    // tokens; `cachedPromptTokens` is the cache-hit subset. Acceptance
    // criterion 2 reconciles SUM(promptTokens) over an hour with
    // LiteLLM_SpendLogs for the same window.
    promptTokens: integer("prompt_tokens").notNull().default(0),
    cachedPromptTokens: integer("cached_prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    // Cost in micro-dollars to keep integer arithmetic exact.
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    // Compaction / context-rotation marker. When the gateway rotates the
    // session or compacts history mid-run, the call that follows carries
    // the before/after sizes so the trimming effect is measurable.
    compacted: integer("compacted").notNull().default(0), // 0 = no, 1 = yes
    preCompactChars: bigint("pre_compact_chars", { mode: "number" }),
    postCompactChars: bigint("post_compact_chars", { mode: "number" }),
    // Set when this row was inferred from heartbeat_runs.usageJson only
    // (no per-call payload from the gateway) — a coarser aggregate.
    inferredFromRun: integer("inferred_from_run").notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Acceptance query #1: per-agent per-hour section/cache shares.
    companyAgentOccurredIdx: index("llm_call_traces_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    // Acceptance query #2: SUM(promptTokens) per hour vs LiteLLM_SpendLogs.
    companyOccurredIdx: index("llm_call_traces_company_occurred_idx").on(
      table.companyId,
      table.occurredAt,
    ),
    // Drill-down by model / tools_rev.
    companyModelOccurredIdx: index("llm_call_traces_company_model_occurred_idx").on(
      table.companyId,
      table.model,
      table.occurredAt,
    ),
    // Join back to the run for log/store correlation.
    runIdx: index("llm_call_traces_run_idx").on(table.heartbeatRunId),
    // De-duplication on re-delivery: same provider call observed twice
    // must not double-count. A NULL langfuseObservationId skips the
    // constraint (Postgres treats NULLs as distinct).
    uniqueObservation: index("llm_call_traces_unique_observation").on(
      table.companyId,
      table.langfuseObservationId,
    ),
  }),
);
