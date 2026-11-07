/**
 * OPE-11718: a queued run refused by the agent's daily run limit waits for the
 * limit to reset; it is not cancelled.
 *
 * The claim gate (`claimQueuedRun`) refuses to start a queued run once the agent
 * has used `maxDailyRuns` for the UTC day. The refusal used to cancel the run,
 * and a cancelled run is final: its task stayed where it was until some outside
 * event woke it again. The limit resets at the next UTC midnight, so the run
 * moves to `scheduled_retry` due then. The existing due-retry sweep promotes it
 * back to the queue, in batches (`MAX_DUE_RETRIES_PER_SWEEP`, oldest due first),
 * and the claim gate checks the limit again. A run refused a second time is
 * deferred again in place: it is the same row, never a second one.
 *
 * Every run deferred by the same limit would fall due at the same instant, so
 * the due time carries a small random delay after the reset; together with the
 * per-sweep batch it spreads the burst of promotions that follows midnight.
 */

/** `scheduled_retry_reason` of a run waiting for the daily run limit to reset; also the gate's own refusal reason. */
export const DAILY_RUN_LIMIT_RETRY_REASON = "heartbeat.daily_run_limit";

/** Upper bound of the random delay added after the reset moment. */
export const DAILY_RUN_LIMIT_DEFER_JITTER_MS = 5 * 60 * 1000;

/** First instant of the UTC day after `now`: the moment the daily limit counts from zero again. */
export function nextDailyRunLimitReset(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

export type DailyRunLimitDeferral = {
  /** When the limit resets. */
  resetAt: Date;
  /** When the deferred run falls due: the reset plus the jitter. */
  dueAt: Date;
};

/**
 * When a run refused at `limit` runs per day may be tried again. A limit of
 * zero never frees a slot, so waiting for a reset would only park the run
 * forever; there is nothing to defer to (null) and the caller cancels it as
 * before.
 */
export function computeDailyRunLimitDeferral(input: {
  now: Date;
  limit: number;
  random?: () => number;
}): DailyRunLimitDeferral | null {
  if (!Number.isFinite(input.limit) || input.limit <= 0) return null;
  const resetAt = nextDailyRunLimitReset(input.now);
  const sample = Math.min(Math.max((input.random ?? Math.random)(), 0), 1);
  // Strictly below the bound: the sample 1 must not land on the next window.
  const jitterMs = Math.min(
    Math.floor(sample * DAILY_RUN_LIMIT_DEFER_JITTER_MS),
    DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1,
  );
  return { resetAt, dueAt: new Date(resetAt.getTime() + jitterMs) };
}
