// server/src/myrmidon/tracing-health/attention-bridge.ts
//
// myrmidon(TRACING-HEALTH): the process-level bridge between the health
// evaluation and the attention feed.
//
// The attention feed must not call the live probes (ClickHouse, LiteLLM
// /metrics) on every desk read — the feed is hot UI surface. Instead the
// service records its latest card into a process-local registry (same shape
// as the maintenance gate's document cache), and the attention feed reads
// the registry only. The card is refreshed by the tracing sweep (below) and
// by the route evaluation; both call `recordTracingHealthSignal`.
//
// Dedup is per state: a red card stays exactly one attention row (the
// dedupKey is stable), and the row disappears the moment the card turns ok
// or the check is disabled — no dismissal bookkeeping needed.

import type { TracingHealthCard, TracingAttentionSignal } from "./service.js";
import { legFailureSummary, TRACING_ATTENTION_DEDUP_KEY } from "./service.js";

const signalByCompany = new Map<string, TracingAttentionSignal & { activityAt: string }>();

/** Record the latest card; a healthy or disabled card clears the signal. */
export function recordTracingHealthSignal(companyId: string, card: TracingHealthCard, now: Date = new Date()): void {
  if (!card.enabled || card.status !== "red") {
    signalByCompany.delete(companyId);
    return;
  }
  signalByCompany.set(companyId, {
    dedupKey: TRACING_ATTENTION_DEDUP_KEY,
    status: card.status,
    summary: card.summary,
    whyNow: `LLM tracing health check is red: ${legFailureSummary(card)}. An operator must check the tracing pipeline (Langfuse ClickHouse events_core and the LiteLLM callbacks); this is not a task-owner problem.`,
    detail: { kind: "generic", summaryExcerpt: card.summary.slice(0, 160) },
    severity: "high",
    activityAt: now.toISOString(),
  });
}

/** The current operator signal, or null while healthy/disabled. */
export function readTracingHealthAttentionSignal(
  companyId: string,
): (TracingAttentionSignal & { activityAt: string }) | null {
  return signalByCompany.get(companyId) ?? null;
}

/** Test helper: forget every recorded signal. */
export function resetTracingHealthSignals(): void {
  signalByCompany.clear();
}
