/**
 * tokens-trace — persistence for per-LLM-call traces (OPE-10727).
 *
 * `persistLlmCallTraces` is called from the heartbeat service after the
 * adapter returns `resultJson.llmCallTraces`. It upserts rows into
 * `llm_call_traces`; re-deliveries (same company + langfuseObservationId)
 * replace rather than double-count. Calls without a `langfuseObservationId`
 * are inserted as-is — the (company_id, langfuse_observation_id) index is
 * not UNIQUE, so NULLs do not collide.
 *
 * `inferFromRunUsage` synthesises one coarse trace row from
 * `heartbeat_runs.usageJson` for runs whose adapter did not emit per-call
 * traces. This keeps the acceptance queries meaningful during the rollout
 * window when some bots run an older gateway image.
 */
import type { Db } from "@myrmidon/db";
import { llmCallTraces } from "@myrmidon/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type {
  AgentTraceAggregate,
  KeySpendAggregate,
  LlmCallTraceInput,
} from "./domain.js";
export { findPerCallMismatches } from "./per-call-reconcile.js";
export type { PerCallMismatch, PerCallPromptRow } from "./per-call-reconcile.js";

export interface PersistTraceArgs {
  db: Db;
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  issueId: string | null;
  occurredAt: Date;
  calls: LlmCallTraceInput[];
}

/** Best-effort persist. Throws only on hard DB errors; callers log+continue. */
export async function persistLlmCallTraces(
  args: PersistTraceArgs,
): Promise<number> {
  if (args.calls.length === 0) return 0;
  const rows = args.calls.map((call) => ({
    companyId: args.companyId,
    agentId: args.agentId,
    heartbeatRunId: args.heartbeatRunId,
    issueId: args.issueId,
    langfuseTraceId: call.langfuseTraceId ?? null,
    langfuseObservationId: call.langfuseObservationId ?? null,
    litellmRequestId: call.litellmRequestId ?? null,
    provider: call.provider ?? null,
    model: call.model ?? null,
    toolsRev: call.toolsRev ?? null,
    toolCount: call.toolCount ?? null,
    systemChars: call.sections.systemChars ?? null,
    systemTokens: call.sections.systemTokens ?? null,
    toolsChars: call.sections.toolsChars ?? null,
    toolsTokens: call.sections.toolsTokens ?? null,
    wakeChars: call.sections.wakeChars ?? null,
    wakeTokens: call.sections.wakeTokens ?? null,
    historyChars: call.sections.historyChars ?? null,
    historyTokens: call.sections.historyTokens ?? null,
    toolResultsChars: call.sections.toolResultsChars ?? null,
    toolResultsTokens: call.sections.toolResultsTokens ?? null,
    totalChars: call.sections.totalChars ?? null,
    totalTokens: call.sections.totalTokens ?? null,
    promptTokens: call.usage.promptTokens,
    cachedPromptTokens: call.usage.cachedPromptTokens,
    completionTokens: call.usage.completionTokens,
    costMicroUsd: call.usage.costMicroUsd ?? null,
    compacted: call.compacted ? 1 : 0,
    preCompactChars: call.preCompactChars ?? null,
    postCompactChars: call.postCompactChars ?? null,
    inferredFromRun: 0,
    occurredAt: args.occurredAt,
  }));

  // De-duplication: if the same (companyId, langfuseObservationId) already
  // exists, replace the row so a re-delivery does not double-count. We
  // cannot lean on a true UNIQUE index because NULL observation ids must
  // remain insertable, so do an explicit pre-delete.
  const observationIds = rows
    .map((r) => r.langfuseObservationId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (observationIds.length > 0) {
    await args.db
      .delete(llmCallTraces)
      .where(
        and(
          eq(llmCallTraces.companyId, args.companyId),
          inArray(llmCallTraces.langfuseObservationId, observationIds),
        ),
      );
  }
  await args.db.insert(llmCallTraces).values(rows);
  return rows.length;
}

/**
 * Synthesise one coarse trace row from heartbeat_runs.usageJson when the
 * adapter did not emit per-call traces. Idempotent: removes any prior
 * inferred row for the same run before inserting.
 */
export async function inferFromRunUsage(args: {
  db: Db;
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  issueId: string | null;
  occurredAt: Date;
  usageJson: Record<string, unknown> | null;
}): Promise<number> {
  const usage = args.usageJson;
  if (!usage || typeof usage !== "object") return 0;
  const promptTokens = Number(usage.rawInputTokens ?? 0);
  const cachedPromptTokens = Number(usage.rawCachedInputTokens ?? 0);
  const completionTokens = Number(usage.rawOutputTokens ?? 0);
  if (
    !Number.isFinite(promptTokens) ||
    !Number.isFinite(cachedPromptTokens) ||
    !Number.isFinite(completionTokens)
  ) {
    return 0;
  }
  if (promptTokens <= 0 && completionTokens <= 0) return 0;

  const breakdown = (usage.promptBreakdown ?? {}) as Record<string, unknown>;
  const sections = (breakdown.sections ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };

  await args.db
    .delete(llmCallTraces)
    .where(
      and(
        eq(llmCallTraces.heartbeatRunId, args.heartbeatRunId),
        eq(llmCallTraces.inferredFromRun, 1),
      ),
    );

  await args.db.insert(llmCallTraces).values({
    companyId: args.companyId,
    agentId: args.agentId,
    heartbeatRunId: args.heartbeatRunId,
    issueId: args.issueId,
    promptTokens,
    cachedPromptTokens,
    completionTokens,
    model: typeof usage.model === "string" ? usage.model : null,
    provider: typeof usage.provider === "string" ? usage.provider : null,
    systemTokens: num(sections.instructionsBundle),
    wakeTokens: num(sections.input),
    totalTokens: num(breakdown.totalTokens),
    totalChars: num(breakdown.totalChars),
    compacted: usage.sessionRotated === true ? 1 : 0,
    inferredFromRun: 1,
    occurredAt: args.occurredAt,
  });
  return 1;
}

/** Aggregate traces per agent over a window — acceptance query #1. */
export async function aggregateByAgent(args: {
  db: Db;
  companyId: string;
  from: Date;
  to: Date;
  agentId?: string;
}): Promise<AgentTraceAggregate[]> {
  const conditions = [
    eq(llmCallTraces.companyId, args.companyId),
    sql`${llmCallTraces.occurredAt} >= ${args.from}`,
    sql`${llmCallTraces.occurredAt} < ${args.to}`,
  ];
  if (args.agentId) {
    conditions.push(eq(llmCallTraces.agentId, args.agentId));
  }
  const rows = await args.db
    .select({
      agentId: llmCallTraces.agentId,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`sum(${llmCallTraces.promptTokens})::int`,
      cachedPromptTokens: sql<number>`sum(${llmCallTraces.cachedPromptTokens})::int`,
      completionTokens: sql<number>`sum(${llmCallTraces.completionTokens})::int`,
      systemTokens: sql<number>`coalesce(sum(${llmCallTraces.systemTokens}), 0)::int`,
      toolsTokens: sql<number>`coalesce(sum(${llmCallTraces.toolsTokens}), 0)::int`,
      wakeTokens: sql<number>`coalesce(sum(${llmCallTraces.wakeTokens}), 0)::int`,
      historyTokens: sql<number>`coalesce(sum(${llmCallTraces.historyTokens}), 0)::int`,
      toolResultsTokens: sql<number>`coalesce(sum(${llmCallTraces.toolResultsTokens}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${llmCallTraces.totalTokens}), 0)::int`,
    })
    .from(llmCallTraces)
    .where(and(...conditions))
    .groupBy(llmCallTraces.agentId);

  // Per-agent per-model and per-tools_rev drill-downs.
  const modelRows = await args.db
    .select({
      agentId: llmCallTraces.agentId,
      model: sql<string>`coalesce(${llmCallTraces.model}, '(unknown)')`,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`sum(${llmCallTraces.promptTokens})::int`,
      cachedPromptTokens: sql<number>`sum(${llmCallTraces.cachedPromptTokens})::int`,
    })
    .from(llmCallTraces)
    .where(and(...conditions))
    .groupBy(llmCallTraces.agentId, sql`coalesce(${llmCallTraces.model}, '(unknown)')`);

  const toolsRevRows = await args.db
    .select({
      agentId: llmCallTraces.agentId,
      toolsRev: sql<string>`coalesce(${llmCallTraces.toolsRev}, '(unknown)')`,
      calls: sql<number>`count(*)::int`,
    })
    .from(llmCallTraces)
    .where(and(...conditions))
    .groupBy(llmCallTraces.agentId, sql`coalesce(${llmCallTraces.toolsRev}, '(unknown)')`);

  return rows.map((row) => {
    const cacheShare =
      row.promptTokens > 0 ? row.cachedPromptTokens / row.promptTokens : null;
    const total = row.totalTokens;
    const share = (v: number) => (total > 0 ? v / total : null);
    return {
      agentId: row.agentId,
      calls: row.calls,
      promptTokens: row.promptTokens,
      cachedPromptTokens: row.cachedPromptTokens,
      completionTokens: row.completionTokens,
      cacheShare,
      sections: {
        systemTokens: row.systemTokens,
        toolsTokens: row.toolsTokens,
        wakeTokens: row.wakeTokens,
        historyTokens: row.historyTokens,
        toolResultsTokens: row.toolResultsTokens,
        totalTokens: row.totalTokens,
      },
      sectionShares: {
        system: share(row.systemTokens),
        tools: share(row.toolsTokens),
        wake: share(row.wakeTokens),
        history: share(row.historyTokens),
        toolResults: share(row.toolResultsTokens),
      },
      byModel: modelRows
        .filter((m) => m.agentId === row.agentId)
        .map((m) => ({
          model: m.model,
          calls: m.calls,
          promptTokens: m.promptTokens,
          cachedPromptTokens: m.cachedPromptTokens,
        })),
      byToolsRev: toolsRevRows
        .filter((t) => t.agentId === row.agentId)
        .map((t) => ({ toolsRev: t.toolsRev, calls: t.calls })),
    };
  });
}

/**
 * Reconciliation against LiteLLM_SpendLogs — acceptance query #2.
 *
 * Joins llm_call_traces with litellm_cost_events on litellmRequestId and
 * compares SUM(promptTokens) over the window. Returns per-key aggregates
 * from both sides plus the relative difference.
 */
export async function reconcileWithSpendLogs(args: {
  db: Db;
  companyId: string;
  from: Date;
  to: Date;
}): Promise<{
  traces: KeySpendAggregate[];
  spendLogs: KeySpendAggregate[];
  comparison: Array<{
    agentId: string;
    tracePromptTokens: number;
    spendLogPromptTokens: number;
    relativeDiff: number | null;
  }>;
}> {
  const { litellmCostEvents } = await import("@myrmidon/db");
  const baseConditions = [
    eq(llmCallTraces.companyId, args.companyId),
    sql`${llmCallTraces.occurredAt} >= ${args.from}`,
    sql`${llmCallTraces.occurredAt} < ${args.to}`,
    sql`${llmCallTraces.litellmRequestId} IS NOT NULL`,
  ];

  const traceRows = await args.db
    .select({
      agentId: litellmCostEvents.agentId,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`sum(${llmCallTraces.promptTokens})::int`,
      cachedPromptTokens: sql<number>`sum(${llmCallTraces.cachedPromptTokens})::int`,
      completionTokens: sql<number>`sum(${llmCallTraces.completionTokens})::int`,
      costMicroUsd: sql<number>`coalesce(sum(${llmCallTraces.costMicroUsd}), 0)::int`,
    })
    .from(llmCallTraces)
    .innerJoin(
      litellmCostEvents,
      eq(llmCallTraces.litellmRequestId, litellmCostEvents.requestId),
    )
    .where(and(...baseConditions))
    .groupBy(litellmCostEvents.agentId);

  const spendConditions = [
    eq(litellmCostEvents.companyId, args.companyId),
    sql`${litellmCostEvents.occurredAt} >= ${args.from}`,
    sql`${litellmCostEvents.occurredAt} < ${args.to}`,
  ];
  const spendRows = await args.db
    .select({
      agentId: litellmCostEvents.agentId,
      calls: sql<number>`count(*)::int`,
      promptTokens: sql<number>`sum(${litellmCostEvents.inputTokens})::int`,
      cachedPromptTokens: sql<number>`0::int`,
      completionTokens: sql<number>`sum(${litellmCostEvents.outputTokens})::int`,
      costMicroUsd: sql<number>`sum(${litellmCostEvents.costCents}) * 10000::int`,
    })
    .from(litellmCostEvents)
    .where(and(...spendConditions))
    .groupBy(litellmCostEvents.agentId);

  const traces: KeySpendAggregate[] = traceRows.map((r) => ({
    agentId: r.agentId,
    calls: r.calls,
    promptTokens: r.promptTokens,
    cachedPromptTokens: r.cachedPromptTokens,
    completionTokens: r.completionTokens,
    costMicroUsd: r.costMicroUsd,
    cacheShare:
      r.promptTokens > 0 ? r.cachedPromptTokens / r.promptTokens : null,
  }));
  const spendLogs: KeySpendAggregate[] = spendRows.map((r) => ({
    agentId: r.agentId,
    calls: r.calls,
    promptTokens: r.promptTokens,
    cachedPromptTokens: r.cachedPromptTokens,
    completionTokens: r.completionTokens,
    costMicroUsd: r.costMicroUsd,
    cacheShare: null,
  }));

  const comparison = traces.map((t) => {
    const s = spendLogs.find((x) => x.agentId === t.agentId);
    const spendPrompt = s?.promptTokens ?? 0;
    const relativeDiff =
      spendPrompt > 0
        ? Math.abs(t.promptTokens - spendPrompt) / spendPrompt
        : null;
    return {
      agentId: t.agentId,
      tracePromptTokens: t.promptTokens,
      spendLogPromptTokens: spendPrompt,
      relativeDiff,
    };
  });

  return { traces, spendLogs, comparison };
}

/** One per-call reconciliation row: a trace row joined to its spend-log row. */
export interface PerCallReconcileRow {
  litellmRequestId: string;
  agentId: string | null;
  model: string | null;
  occurredAt: Date;
  tracePromptTokens: number;
  traceCachedPromptTokens: number;
  traceCompletionTokens: number;
  spendLogPromptTokens: number | null;
  spendLogCompletionTokens: number | null;
}

/**
 * Per-call reconciliation detail — the row-level evidence behind
 * `reconcileWithSpendLogs`. Each returned row is one provider call joined
 * on `litellmRequestId` against `litellm_cost_events`. Calls with no
 * matching spend-log row appear with null spend-log fields (they are not
 * silently dropped); spend-log rows with no trace row are not listed here
 * (the aggregate comparison in `reconcileWithSpendLogs` covers that side).
 */
export async function reconcilePerCall(args: {
  db: Db;
  companyId: string;
  from: Date;
  to: Date;
  limit?: number;
}): Promise<PerCallReconcileRow[]> {
  const { litellmCostEvents } = await import("@myrmidon/db");
  const cap = Math.min(Math.max(args.limit ?? 500, 1), 5000);
  const rows = await args.db
    .select({
      litellmRequestId: llmCallTraces.litellmRequestId,
      agentId: litellmCostEvents.agentId,
      model: llmCallTraces.model,
      occurredAt: llmCallTraces.occurredAt,
      tracePromptTokens: llmCallTraces.promptTokens,
      traceCachedPromptTokens: llmCallTraces.cachedPromptTokens,
      traceCompletionTokens: llmCallTraces.completionTokens,
      spendLogPromptTokens: litellmCostEvents.inputTokens,
      spendLogCompletionTokens: litellmCostEvents.outputTokens,
    })
    .from(llmCallTraces)
    .leftJoin(
      litellmCostEvents,
      eq(llmCallTraces.litellmRequestId, litellmCostEvents.requestId),
    )
    .where(
      and(
        eq(llmCallTraces.companyId, args.companyId),
        sql`${llmCallTraces.occurredAt} >= ${args.from}`,
        sql`${llmCallTraces.occurredAt} < ${args.to}`,
        sql`${llmCallTraces.litellmRequestId} IS NOT NULL`,
      ),
    )
    .orderBy(llmCallTraces.occurredAt)
    .limit(cap);
  return rows.map((r) => ({
    litellmRequestId: r.litellmRequestId as string,
    agentId: r.agentId,
    model: r.model,
    occurredAt: r.occurredAt,
    tracePromptTokens: r.tracePromptTokens,
    traceCachedPromptTokens: r.traceCachedPromptTokens,
    traceCompletionTokens: r.traceCompletionTokens,
    spendLogPromptTokens: r.spendLogPromptTokens,
    spendLogCompletionTokens: r.spendLogCompletionTokens,
  }));
}
