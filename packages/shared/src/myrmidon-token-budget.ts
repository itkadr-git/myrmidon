// packages/shared/src/myrmidon-token-budget.ts
//
// myrmidon(1.7 TOKEN-BUDGET-SIGNAL, OPE-12232): the shared contract of the
// issue token budget — a SIGNAL, never a limit.
//
// The budget on tokens of one task (scopeType "issue", metric "issue_tokens")
// is informational by design (Alex's decision on the epic): it never pauses a
// scope, never sets a pauseReason, never refuses a run and never creates a
// budget incident or approval. The money metric ("billed_cents") keeps its
// whole enforcement pipeline unchanged — pause, incidents, admission block.
//
// Levels come from utilization of the issue's token ledger (the cost_events
// token columns of the issue): "warn" at the policy warn percent (~80% by
// default), "info" from the info percent, "none" below it or without a
// budget. Everything here is pure data and pure functions: the server
// computes the signal on read, the UI renders the level.

import { z } from "zod";

/** Levels of the token-budget signal: quiet, informational, warning. */
export const TOKEN_BUDGET_SIGNAL_LEVELS = ["none", "info", "warn"] as const;
export type TokenBudgetSignalLevel = (typeof TOKEN_BUDGET_SIGNAL_LEVELS)[number];

/**
 * Where "info" starts when a policy does not say otherwise. "warn" comes from
 * the policy's own warnPercent (default 80 — the epic's "~80%").
 */
export const TOKEN_BUDGET_SIGNAL_DEFAULT_INFO_PERCENT = 50;

/**
 * The level for an observed token amount against the budget:
 *  - "none": no budget or no recorded spend yet;
 *  - "warn": observed reached the warn threshold (ceil of amount × warnPercent);
 *  - "info": observed reached the info threshold, below warn.
 * Warn wins over info; both thresholds are inclusive percentages of the amount.
 */
export function tokenBudgetSignalLevel(
  observedTokens: number,
  amountTokens: number,
  warnPercent = 80,
  infoPercent = TOKEN_BUDGET_SIGNAL_DEFAULT_INFO_PERCENT,
): TokenBudgetSignalLevel {
  if (amountTokens <= 0 || observedTokens <= 0) return "none";
  if (observedTokens >= Math.ceil((amountTokens * warnPercent) / 100)) return "warn";
  if (observedTokens >= Math.ceil((amountTokens * infoPercent) / 100)) return "info";
  return "none";
}

/**
 * The signal payload the server returns for one issue. `enforcement` is a
 * contract literal, not a knob: the token budget cannot pause or block —
 * a payload claiming anything else would violate the epic decision.
 */
export const tokenBudgetSignalSchema = z.object({
  level: z.enum(TOKEN_BUDGET_SIGNAL_LEVELS),
  /** The signal speaks about one task; that scope never pauses. */
  scopeType: z.literal("issue"),
  scopeId: z.string().min(1),
  policyId: z.string().min(1),
  metric: z.literal("issue_tokens"),
  amountTokens: z.number().int().nonnegative(),
  observedTokens: z.number().nonnegative(),
  utilizationPercent: z.number().nonnegative(),
  warnPercent: z.number().int().min(1).max(99),
  /** Always "signal": no pause, no pauseReason, no run refusal. */
  enforcement: z.literal("signal"),
});

export type TokenBudgetSignal = z.infer<typeof tokenBudgetSignalSchema>;

/**
 * The pure builder behind the server's read path: level + utilization from
 * the observed tokens. Returns null when there is nothing to signal about
 * (no budget rows carry amount <= 0 as "no budget" upstream).
 */
export function buildTokenBudgetSignal(input: {
  policyId: string;
  scopeId: string;
  amountTokens: number;
  observedTokens: number;
  warnPercent?: number;
  infoPercent?: number;
}): TokenBudgetSignal {
  const warnPercent = input.warnPercent ?? 80;
  const amountTokens = input.amountTokens;
  const observedTokens = input.observedTokens;
  const utilizationPercent =
    amountTokens > 0 ? Number(((observedTokens / amountTokens) * 100).toFixed(2)) : 0;
  return {
    level: tokenBudgetSignalLevel(observedTokens, amountTokens, warnPercent, input.infoPercent),
    scopeType: "issue",
    scopeId: input.scopeId,
    policyId: input.policyId,
    metric: "issue_tokens",
    amountTokens,
    observedTokens,
    utilizationPercent,
    warnPercent,
    enforcement: "signal",
  };
}
