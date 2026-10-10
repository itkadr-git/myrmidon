// server/src/myrmidon/long-task-context/domain.ts
//
// myrmidon(1.6.6 LONG-TASK-CONTEXT): the pure decisions of the long-task
// context guard — no database, no clock, no io, so the whole behaviour is
// testable from literals.
//
// Two things live here:
//
//   1. the failure signatures the runtime prints when its own context
//      compression gives up. The board must recognise those as a context
//      window condition (recoverable: reset the task session, keep the agent
//      idle) rather than as an agent failure, otherwise the ticket stays
//      stuck in `error` until a human resets it by hand;
//   2. the reset plan: given the accumulated prompt size, the window and the
//      settings, whether the next launch must start from the continuation
//      summary instead of the accumulated session, plus the wording the run
//      log and the launch notice use.

import {
  shouldResetTaskSessionForLongTaskContext,
  longTaskContextPct,
  type LongTaskContextSettings,
} from "@paperclipai/shared";

/**
 * What the runtime prints when compression could not finish inside its budget.
 *
 * The two production shapes (09.10.2026):
 *   - "Context compression timed out: approximately 214 298 / 378 739 tokens"
 *   - "Context compression timed out without reducing this conversation"
 *
 * Matching is case-insensitive substring matching, so both shapes — and the
 * truncated variants a log line can carry — are covered.
 */
export const COMPRESSION_TIMEOUT_ERROR_SIGNATURES = [
  "context compression timed out",
  "compression timed out without reducing this conversation",
] as const;

/** True when the message is one of the runtime's compression-timeout shapes. */
export function isCompressionTimeoutError(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return COMPRESSION_TIMEOUT_ERROR_SIGNATURES.some((signature) =>
    normalized.includes(signature.toLowerCase()),
  );
}

/**
 * Where the omitted part of the history stays readable.
 *
 * Long tasks are exactly the ones whose payload must not carry the whole
 * thread; the older entries are referenced instead of inlined. The path is the
 * board API, which needs no UI origin to be resolvable.
 */
export function issueThreadReference(issueId: string | null | undefined): string {
  const id = typeof issueId === "string" && issueId.trim() ? issueId.trim() : null;
  if (!id) return "the task thread through the issue API";
  return `GET /api/issues/${id}/comments (oldest first)`;
}

export interface LongTaskContextPlan {
  /** True when the next launch must start from the continuation summary. */
  reset: boolean;
  /** The accumulated prompt's share of the window, percent. */
  pct: number;
  windowTokens: number;
  promptTotal: number | null;
  lastRunId: string | null;
  /** The run-log reason; null when nothing is reset. */
  reason: string | null;
}

/**
 * The reset decision of one launch.
 *
 * `promptTotal` is the prompt size of the task's last run (the session's own
 * footprint), `null` when the task has no run with a usable size yet — a task
 * that never ran cannot be over any window, so it never resets.
 */
export function planLongTaskContextReset(input: {
  settings: LongTaskContextSettings;
  promptTotal: number | null;
  windowTokens: number;
  lastRunId?: string | null;
}): LongTaskContextPlan {
  const pct = longTaskContextPct(input.promptTotal ?? 0, input.windowTokens);
  const reset = shouldResetTaskSessionForLongTaskContext({
    settings: input.settings,
    promptTotal: input.promptTotal,
    windowTokens: input.windowTokens,
  });
  return {
    reset,
    pct,
    windowTokens: input.windowTokens,
    promptTotal: input.promptTotal,
    lastRunId: input.lastRunId ?? null,
    reason: reset
      ? `long-task context guard: the last run's prompt took ${pct}% of the ${input.windowTokens}-token window ` +
        `(threshold ${input.settings.resetPct}%), so the task session is reset and the run starts from the continuation summary`
      : null,
  };
}

/** The notice the launch payload and the run log carry when a session is dropped. */
export function buildLongTaskContextResetNotice(input: {
  plan: LongTaskContextPlan;
  settings: LongTaskContextSettings;
  issueId?: string | null;
}): string {
  const prompt = input.plan.promptTotal === null ? "an unknown size" : `${input.plan.promptTotal} tokens`;
  return (
    "Long-task context guard: this run starts a FRESH task session. The previous session's last prompt was " +
    `${prompt} (${input.plan.pct}% of the ${input.plan.windowTokens}-token window, threshold ` +
    `${input.settings.resetPct}%), so it was dropped before the window was reached — resuming it would have ` +
    'ended in "Context compression timed out". The continuation summary below carries the work done so far; ' +
    `older entries of the thread stay readable through ${issueThreadReference(input.issueId)}.`
  );
}