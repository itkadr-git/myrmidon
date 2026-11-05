// server/src/myrmidon/litellm-costs/attention.ts
//
// myrmidon(1.6.5-F-18): the operator signal behind "the gateway model
// catalog is empty".
//
// The defect this guards: the sweep's accounting key was created with a
// restricted model list (no default models), so /v1/model/info answered an
// empty list on a perfectly successful HTTP exchange, litellm_models stayed
// empty, and every feature that reads the catalog (prices, model lists,
// entry limits) silently did nothing. A healthy sweep must leave at least
// one model row behind; an empty catalog is a key misconfiguration, not a
// quiet window — the operator hears about it instead of nothing happening.
//
// The shape follows tracing-health (one card per company, process-level
// registry the attention feed reads on every list, no new table): the cost
// sweep records the outcome of its catalog refresh on every pass, the feed
// turns the recorded signal into a card. Dedup is one stable dedupKey per
// company: repeated empty sweeps keep the same card, and the first sweep
// that sees a non-empty catalog clears it — no dismissal bookkeeping. The
// first pass right after the server start records the same way, so a
// misconfigured key surfaces immediately, not after one interval.

import type { AttentionSeverity } from "@myrmidon/shared";

/** Stable per-company dedup key: one card while the catalog stays empty. */
export const EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX = "litellm_empty_catalog:";

export function emptyCatalogDedupKey(companyId: string): string {
  return `${EMPTY_CATALOG_ATTENTION_DEDUP_PREFIX}${companyId}`;
}

export interface EmptyCatalogAttentionSignal {
  dedupKey: string;
  companyId: string;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  summary: string;
  /** ISO timestamp of the sweep that recorded the empty catalog. */
  activityAt: string;
}

export const EMPTY_CATALOG_ATTENTION_TITLE = "Gateway model catalog is empty";

export const EMPTY_CATALOG_ATTENTION_WHY_NOW =
  "The spend collection sweep completed, but the gateway's model catalog (/v1/model/info) answered with 0 models. " +
  "The usual cause is the accounting key (MYRMIDON_LITELLM_KEY_SECRET) created with a restricted model list — " +
  "with no default models the gateway answers an empty list on a successful request, so prices, model lists and " +
  "entry limits silently stop working. Re-create the key with an empty model list (access to all models) and access " +
  "to /spend/logs/v2 and /v1/model/info; the card disappears on the first sweep that sees a non-empty catalog.";

/** The signal for a sweep whose catalog refresh returned 0 models. */
export function emptyCatalogSignalForSweep(companyId: string, activityAt: string): EmptyCatalogAttentionSignal {
  return {
    dedupKey: emptyCatalogDedupKey(companyId),
    companyId,
    severity: "high",
    title: EMPTY_CATALOG_ATTENTION_TITLE,
    whyNow: EMPTY_CATALOG_ATTENTION_WHY_NOW,
    summary: "0 models in the gateway catalog after a successful sweep",
    activityAt,
  };
}

// ---------------------------------------------------------------------------
// LiteLLM key budget signals
// ---------------------------------------------------------------------------

export const LITELLM_BUDGET_ATTENTION_DEDUP_PREFIX = "litellm_budget:";
export const LITELLM_NEAR_CAP_PERCENT = 80;
export const LITELLM_ANOMALY_MULTIPLIER = 2;

export type LitellmBudgetSignalKind = "near_cap" | "exhausted" | "daily_anomaly";

export interface LitellmBudgetAttentionSignal {
  dedupKey: string;
  companyId: string;
  agentId: string;
  kind: LitellmBudgetSignalKind;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  summary: string;
  activityAt: string;
  observedPercent: number;
  dailySpendCents: number;
  weeklySpendCents: number;
  capCents: number;
}

function litellmBudgetDedupKey(companyId: string, agentId: string, kind: LitellmBudgetSignalKind): string {
  return `${LITELLM_BUDGET_ATTENTION_DEDUP_PREFIX}${kind}:${companyId}:${agentId}`;
}

/**
 * Pure classification for one key. Gateway cumulative spend is used for cap
 * utilization; the board ledger's daily/weekly spend is used for anomaly
 * detection. Routing/delivery is deliberately left to the attention caller,
 * which owns the OPE-11751 escalation policy.
 */
export function litellmBudgetSignalsForKey(input: {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  capCents: number | null;
  gatewaySpendCents: number | null;
  dailySpendCents: number;
  weeklySpendCents: number;
  activityAt: string;
  anomalyMultiplier?: number;
}): LitellmBudgetAttentionSignal[] {
  const signals: LitellmBudgetAttentionSignal[] = [];
  const name = input.agentName?.trim() || input.agentId;
  const cap = input.capCents ?? 0;
  const observed = input.gatewaySpendCents ?? 0;
  const percent = cap > 0 && input.gatewaySpendCents != null ? (observed / cap) * 100 : null;
  const base = {
    companyId: input.companyId,
    agentId: input.agentId,
    activityAt: input.activityAt,
    observedPercent: percent ?? 0,
    dailySpendCents: input.dailySpendCents,
    weeklySpendCents: input.weeklySpendCents,
    capCents: cap,
  };
  if (percent != null && percent >= 100) {
    signals.push({
      ...base,
      dedupKey: litellmBudgetDedupKey(input.companyId, input.agentId, "exhausted"),
      kind: "exhausted",
      severity: "critical",
      title: `LiteLLM key exhausted: ${name}`,
      whyNow: `Gateway spend is ${percent.toFixed(1)}% of the key cap.`,
      summary: "The LiteLLM key has reached or exceeded its configured cap.",
    });
  } else if (percent != null && percent >= LITELLM_NEAR_CAP_PERCENT) {
    signals.push({
      ...base,
      dedupKey: litellmBudgetDedupKey(input.companyId, input.agentId, "near_cap"),
      kind: "near_cap",
      severity: "high",
      title: `LiteLLM key near cap: ${name}`,
      whyNow: `Gateway spend is ${percent.toFixed(1)}% of the key cap.`,
      summary: "The LiteLLM key has reached the 80% budget warning threshold.",
    });
  }
  const multiplier = input.anomalyMultiplier ?? LITELLM_ANOMALY_MULTIPLIER;
  const weeklyDailyAverage = input.weeklySpendCents / 7;
  if (input.dailySpendCents > 0 && weeklyDailyAverage > 0 && input.dailySpendCents >= weeklyDailyAverage * multiplier) {
    signals.push({
      ...base,
      dedupKey: litellmBudgetDedupKey(input.companyId, input.agentId, "daily_anomaly"),
      kind: "daily_anomaly",
      severity: "high",
      title: `LiteLLM daily spend anomaly: ${name}`,
      whyNow: `Today's spend is ${input.dailySpendCents} cents versus a 7-day daily average of ${Math.round(weeklyDailyAverage)} cents.`,
      summary: `Daily spend is at least ${multiplier}x the 7-day daily average.`,
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Process-level registry the attention feed reads
// ---------------------------------------------------------------------------

const signalByCompany = new Map<string, EmptyCatalogAttentionSignal>();
const budgetSignalsByCompany = new Map<string, LitellmBudgetAttentionSignal[]>();

/** Record the latest key-budget classification for the attention feed. */
export function recordLitellmBudgetSignals(companyId: string, signals: LitellmBudgetAttentionSignal[]): void {
  budgetSignalsByCompany.set(companyId, signals);
}

/** Read the latest key-budget classifications recorded by the gateway-key projection. */
export function readLitellmBudgetSignals(companyId: string): LitellmBudgetAttentionSignal[] {
  return budgetSignalsByCompany.get(companyId) ?? [];
}

/**
 * Records the outcome of one sweep's catalog refresh. `catalogSize` is the
 * number of models the gateway returned on a successful read; `null` means
 * the read itself failed (already logged by the sweep) and changes nothing —
 * an unreachable gateway is not proof of a misconfigured key. 0 records the
 * signal (once — the same card is kept while the catalog stays empty), any
 * positive count clears it.
 */
export function recordEmptyCatalogSweep(companyId: string, catalogSize: number | null, activityAt: string): void {
  if (catalogSize === null) return;
  if (catalogSize > 0) {
    signalByCompany.delete(companyId);
    return;
  }
  signalByCompany.set(companyId, emptyCatalogSignalForSweep(companyId, activityAt));
}

/** The current operator signal, or null while the catalog is non-empty. */
export function readEmptyCatalogSignal(companyId: string): EmptyCatalogAttentionSignal | null {
  return signalByCompany.get(companyId) ?? null;
}

export function resetLitellmBudgetSignals(): void {
  budgetSignalsByCompany.clear();
}

/** Forget every recorded signal: tests, and a disabled sweep clears its cards. */
export function resetEmptyCatalogSignals(): void {
  signalByCompany.clear();
  resetLitellmBudgetSignals();
}
