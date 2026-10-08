// server/src/myrmidon/foraging/limits.ts
//
// myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend limits on the learning sweep.
//
// The pass budget of 1.6-FORAGE priced one pass; the owner's 03.10 decision
// adds the ceilings the ticket names: per-company daily and monthly, per role
// and per agent. All of them are checked from what the passes actually
// recorded — every read's cost estimate lands in the findings and pass
// accounting, so the windows are plain queries over the existing tables; no
// new ledger, no double bookkeeping with the vendor cost events.
//
// Three decisions live here, pure, so the tests can pin them:
//
//  1. Whether a pass may start / continue given the already-spent sums and the
//     resolved limits (the pass budget, the windows, the role/agent ceilings).
//     The stop is a normal outcome (stopped_by_limit), never an error.
//  2. What the operator sees when a limit stops the pass: one attention
//     signal per company (a process-level registry, the same shape the
//     tracing-health and stale-block signals use — the feed computes the card
//     on the fly, nothing to store). In the soft mode the card asks the owner
//     to raise the limit or switch learning off; in the hard mode it states
//     the stop. The card disappears when the next pass runs without a stop.
//  3. The auto-off rule (owner's 29.09 addition): when the BASELINE
//     cost-per-task mean rose above the configured threshold, the sweep
//     switches itself off and raises a signal. The check is injected as a
//     port — the metric itself belongs to the BASELINE module.
//
// The spend of a pass is recorded by the service (spentCents per pass and per
// role), which the windows read back. Role and agent names come from the
// source registry rows (role) and from the findings' assignees (agent), the
// same attribution the Costs screens use.

import type { AttentionSeverity } from "@paperclipai/shared";
import type { ForagingSettings } from "@paperclipai/shared";

/** Stable per-company dedup key: one card while the limit stands. */
export const FORAGING_LIMIT_DEDUP_KEY = "foraging_limits:learning";

/** Stable dedup key of the auto-off signal. */
export const FORAGING_AUTO_OFF_DEDUP_KEY = "foraging_limits:auto_off";

/** The UTC day/month window starts, the unit the limits are checked in. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

export function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/** What a pass has already spent, read back from the recorded passes. */
export interface ForagingSpendWindows {
  companyId: string;
  dayCents: number;
  monthCents: number;
  /** Spent today per role (the registry row's role). */
  byRole: Map<string, number>;
  /** Spent today per agent id (the source's agent, when known). */
  byAgent: Map<string, number>;
}

/** Why a pass was stopped — the pass reports the first limit it crossed. */
export type ForagingLimitKind =
  | "pass_budget"
  | "company_daily"
  | "company_monthly"
  | "role_daily"
  | "agent_daily";

export interface ForagingLimitDecision {
  allowed: boolean;
  /** The limit that would be crossed by spending `estimateCents` more. */
  limit: ForagingLimitKind | null;
  /** Human line for the log and the card. */
  reason: string | null;
}

/**
 * Whether one more read (costing `estimateCents`) may start. The pass budget
 * itself is decided by the sweep domain (`decideForagingBudget`); this checks
 * the windows and the role/agent ceilings. A `null` ceiling is "no ceiling".
 */
export function decideForagingLimits(input: {
  settings: Pick<
    ForagingSettings,
    "dailyBudgetCents" | "monthlyBudgetCents" | "roleBudgetCents" | "agentBudgetCents"
  >;
  spend: Pick<ForagingSpendWindows, "dayCents" | "monthCents">;
  role: string;
  roleSpentCents: number;
  agentId: string | null;
  agentSpentCents: number;
  estimateCents: number;
}): ForagingLimitDecision {
  const { settings, spend, estimateCents } = input;
  if (settings.dailyBudgetCents !== null && spend.dayCents + estimateCents > settings.dailyBudgetCents) {
    return {
      allowed: false,
      limit: "company_daily",
      reason: `the daily learning limit of ${settings.dailyBudgetCents}c was reached (${spend.dayCents}c spent today)`,
    };
  }
  if (
    settings.monthlyBudgetCents !== null &&
    spend.monthCents + estimateCents > settings.monthlyBudgetCents
  ) {
    return {
      allowed: false,
      limit: "company_monthly",
      reason: `the monthly learning limit of ${settings.monthlyBudgetCents}c was reached (${spend.monthCents}c spent this month)`,
    };
  }
  if (
    settings.roleBudgetCents !== null &&
    input.roleSpentCents + estimateCents > settings.roleBudgetCents
  ) {
    return {
      allowed: false,
      limit: "role_daily",
      reason: `the daily learning limit of ${settings.roleBudgetCents}c for the role "${input.role}" was reached`,
    };
  }
  if (
    settings.agentBudgetCents !== null &&
    input.agentId !== null &&
    input.agentSpentCents + estimateCents > settings.agentBudgetCents
  ) {
    return {
      allowed: false,
      limit: "agent_daily",
      reason: `the daily learning limit of ${settings.agentBudgetCents}c for one agent was reached`,
    };
  }
  return { allowed: true, limit: null, reason: null };
}

/** The limit the pass must not exceed in total today (for the stop checks). */
export function foragingDailyCeiling(settings: Pick<ForagingSettings, "dailyBudgetCents">): number | null {
  return settings.dailyBudgetCents;
}

// ---------------------------------------------------------------------------
// The attention signal registry (process-level, like tracing-health).
// ---------------------------------------------------------------------------

export interface ForagingLimitSignal {
  dedupKey: string;
  companyId: string;
  severity: AttentionSeverity;
  title: string;
  whyNow: string;
  /** ISO timestamp of the pass that recorded the stop. */
  activityAt: string;
}

/** Build the card text for a stopped pass; the mode decides the ask. */
export function foragingLimitWhyNow(input: {
  enforcement: "hard" | "soft";
  reason: string;
}): string {
  const base = `A foraging pass stopped: ${input.reason}. The sources after the stop stay untouched; the next pass continues with them.`;
  if (input.enforcement === "soft") {
    return `${base} Soft mode: the owner is asked to raise the limit or switch learning off.`;
  }
  return base;
}

export function foragingLimitSignal(input: {
  companyId: string;
  reason: string;
  enforcement: "hard" | "soft";
  activityAt: string;
}): ForagingLimitSignal {
  return {
    dedupKey: FORAGING_LIMIT_DEDUP_KEY,
    companyId: input.companyId,
    severity: "high",
    title: "Learning (foraging) hit a spend limit",
    whyNow: foragingLimitWhyNow(input),
    activityAt: input.activityAt,
  };
}

/** The auto-off signal text. */
export function foragingAutoOffWhyNow(meanCents: number, thresholdCents: number): string {
  return `Automatic learning shutoff: the mean cost per task rose to ${meanCents}c (BASELINE window), above the configured threshold of ${thresholdCents}c. Foraging was switched off; raise the threshold or investigate the cost rise before turning it back on.`;
}

export function foragingAutoOffSignal(input: {
  companyId: string;
  meanCents: number;
  thresholdCents: number;
  activityAt: string;
}): ForagingLimitSignal {
  return {
    dedupKey: FORAGING_AUTO_OFF_DEDUP_KEY,
    companyId: input.companyId,
    severity: "high",
    title: "Learning (foraging) switched off by the cost-per-task threshold",
    whyNow: foragingAutoOffWhyNow(input.meanCents, input.thresholdCents),
    activityAt: input.activityAt,
  };
}

const limitSignalsByCompany = new Map<string, ForagingLimitSignal>();
const autoOffSignalsByCompany = new Map<string, ForagingLimitSignal>();

/** The sweep records the stop; a pass without a stop clears the card. */
export function recordForagingLimitSignal(signal: ForagingLimitSignal): void {
  limitSignalsByCompany.set(signal.companyId, signal);
}

/** Clear the limit card — the next pass ran without a stop. */
export function clearForagingLimitSignal(companyId: string): void {
  limitSignalsByCompany.delete(companyId);
}

/** The current limit signal, or null while passes run free. */
export function readForagingLimitSignal(companyId: string): ForagingLimitSignal | null {
  return limitSignalsByCompany.get(companyId) ?? null;
}

/** The auto-off signal stays until an operator re-enables learning. */
export function recordForagingAutoOffSignal(signal: ForagingLimitSignal): void {
  autoOffSignalsByCompany.set(signal.companyId, signal);
}

export function clearForagingAutoOffSignal(companyId: string): void {
  autoOffSignalsByCompany.delete(companyId);
}

export function readForagingAutoOffSignal(companyId: string): ForagingLimitSignal | null {
  return autoOffSignalsByCompany.get(companyId) ?? null;
}

/** Test helper: forget every recorded signal. */
export function resetForagingSignals(): void {
  limitSignalsByCompany.clear();
  autoOffSignalsByCompany.clear();
}
