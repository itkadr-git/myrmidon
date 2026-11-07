/**
 * OPE-11718: a queued run refused by the agent's daily run limit waits for the
 * limit to reset; it is not cancelled.
 *
 * The claim gate (`claimQueuedRun`) refuses to start a queued run once the agent
 * has used `maxDailyRuns` for the UTC day. The refusal used to cancel the run,
 * and a cancelled run is final: its task stayed where it was until some outside
 * event woke it again. The limit resets at the end of the UTC day window the
 * gate counted in (`windowEnd` of its verdict), so the run moves to
 * `scheduled_retry` due then. The existing due-retry sweep promotes it back to
 * the queue, in batches (`MAX_DUE_RETRIES_PER_SWEEP`, oldest due first), and the
 * claim gate checks the limit again. A run refused a second time is deferred
 * again in place: it is the same row, never a second one.
 *
 * The run's own retry identity (`scheduled_retry_reason`, `scheduled_retry_attempt`)
 * is not touched: the failure counter (`executionFailureRetryCount`), the
 * workspace-busy ladder and the retry kind the gates read all derive from them.
 * That the run waits for the limit is recorded only in
 * `contextSnapshot.dailyRunLimitDeferral` (`DAILY_RUN_LIMIT_DEFERRAL_CONTEXT_KEY`).
 *
 * Every run deferred by the same limit would fall due at the same instant, so
 * the due time carries a small random delay after the reset; together with the
 * per-sweep batch it spreads the burst of promotions that follows midnight.
 */

/** The gate's own refusal reason for the daily run limit. */
export const DAILY_RUN_LIMIT_RETRY_REASON = "heartbeat.daily_run_limit";

/** Key of the context marker that says a `scheduled_retry` run waits for the daily run limit to reset. */
export const DAILY_RUN_LIMIT_DEFERRAL_CONTEXT_KEY = "dailyRunLimitDeferral";

/** Upper bound of the random delay added after the reset moment. */
export const DAILY_RUN_LIMIT_DEFER_JITTER_MS = 5 * 60 * 1000;

export type DailyRunLimitDeferral = {
  /** When the limit resets: the end of the day window the gate counted in. */
  resetAt: Date;
  /** When the deferred run falls due: the reset plus the jitter. */
  dueAt: Date;
};

/**
 * When a run refused at `limit` runs per day may be tried again. `resetAt` is
 * the end of the window the refusing gate counted in, so the due time cannot
 * land a day late when the clock crosses midnight between the count and this
 * call. A limit of zero never frees a slot, so waiting for a reset would only
 * park the run forever; there is nothing to defer to (null) and the caller
 * cancels it as before. A random source that returns anything but a number
 * gives no jitter.
 */
export function computeDailyRunLimitDeferral(input: {
  resetAt: Date;
  limit: number;
  random?: () => number;
}): DailyRunLimitDeferral | null {
  if (!Number.isFinite(input.limit) || input.limit <= 0) return null;
  if (!Number.isFinite(input.resetAt.getTime())) return null;
  const raw = (input.random ?? Math.random)();
  const sample = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  // Strictly below the bound: the sample 1 must not land on the next window.
  const jitterMs = Math.min(
    Math.floor(sample * DAILY_RUN_LIMIT_DEFER_JITTER_MS),
    DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1,
  );
  return { resetAt: input.resetAt, dueAt: new Date(input.resetAt.getTime() + jitterMs) };
}
