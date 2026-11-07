/**
 * Pure per-call reconciliation rule (OPE-10727 acceptance #2).
 *
 * Kept free of any DB / drizzle imports so the acceptance rule — "every
 * traced provider call reconciles against its LiteLLM spend-log row within
 * a 5% prompt-token tolerance, and no traced call is silently dropped" —
 * is unit-testable without a database and reusable from any caller.
 */

export interface PerCallPromptRow {
  litellmRequestId: string;
  tracePromptTokens: number;
  /** null when the trace row has no matching litellm_cost_events row. */
  spendLogPromptTokens: number | null;
}

export type PerCallMismatchKind =
  | "relative_diff_exceeded"
  | "missing_spend_log";

export interface PerCallMismatch {
  litellmRequestId: string;
  kind: PerCallMismatchKind;
  tracePromptTokens: number;
  spendLogPromptTokens: number | null;
  relativeDiff: number | null;
}

export const DEFAULT_PER_CALL_TOLERANCE = 0.05;

/**
 * A row is a mismatch when the spend-log side is present and the absolute
 * relative difference in prompt tokens exceeds `tolerance` (default 5%),
 * or when the spend-log side is missing (unreconciled call).
 *
 * Boundary: a difference exactly equal to the tolerance is NOT a mismatch
 * (the acceptance rule is "not greater than 5%").
 */
export function findPerCallMismatches(
  rows: ReadonlyArray<PerCallPromptRow>,
  tolerance: number = DEFAULT_PER_CALL_TOLERANCE,
): PerCallMismatch[] {
  const mismatches: PerCallMismatch[] = [];
  for (const row of rows) {
    if (row.spendLogPromptTokens === null) {
      mismatches.push({
        litellmRequestId: row.litellmRequestId,
        kind: "missing_spend_log",
        tracePromptTokens: row.tracePromptTokens,
        spendLogPromptTokens: null,
        relativeDiff: null,
      });
      continue;
    }
    if (row.spendLogPromptTokens <= 0) continue;
    const relativeDiff =
      Math.abs(row.tracePromptTokens - row.spendLogPromptTokens) /
      row.spendLogPromptTokens;
    if (relativeDiff > tolerance) {
      mismatches.push({
        litellmRequestId: row.litellmRequestId,
        kind: "relative_diff_exceeded",
        tracePromptTokens: row.tracePromptTokens,
        spendLogPromptTokens: row.spendLogPromptTokens,
        relativeDiff,
      });
    }
  }
  return mismatches;
}
