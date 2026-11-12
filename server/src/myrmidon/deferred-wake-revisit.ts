/**
 * Revisit cadence of deferred issue-execution wakes (1.6.8 OPE-12807).
 *
 * The queued-run sweep re-reads every `deferred_issue_execution` wake it
 * cannot advance (a "do not replay" hold, a wake without a legacy owner run,
 * an interaction receipt without an answer) and moves the wake's `updatedAt`
 * as a scan cursor. With a cursor gate of 30 s (reconcile) or no gate at all
 * (stranded-queue scan) the same 50 wakes were re-evaluated on every pass:
 * tens of millions of cursor updates and run lookups for work whose
 * conditions had not changed.
 *
 * A wake that was looked at is looked at again only after this cool-down. The
 * cursor itself is the clock, so the gate is stateless, survives a restart and
 * keeps the bounded scan fair: a revisited wake goes to the tail of the
 * `updatedAt` order. The cost is that a lifted hold is noticed up to one
 * cool-down later, the same order as the scheduler tick.
 *
 * The stranded-queue scan exempts a fresh wake from the cool-down. A new wake's
 * `updatedAt` is its creation time, not a look, and a wake requested moments
 * ago is the normal case of a queue whose owner run is about to finish: it
 * must be promoted on the first pass after the lock is free, without a click.
 * Only a wake older than the fresh window, the long-stranded kind that caused
 * the load, is paced by the cool-down.
 */
export const DEFERRED_WAKE_REVISIT_COOLDOWN_MS = 5 * 60_000;

/** Age up to which a wake is looked at on every pass of the stranded-queue scan. */
export const DEFERRED_WAKE_FRESH_WINDOW_MS = 10 * 60_000;

/** A wake requested after this moment is fresh and not paced by the cool-down. */
export function deferredWakeFreshSince(nowMs: number): Date {
  return new Date(nowMs - DEFERRED_WAKE_FRESH_WINDOW_MS);
}

/** Latest `updatedAt` a wake may carry to be due for another look. */
export function deferredWakeRevisitCutoff(nowMs: number): Date {
  return new Date(nowMs - DEFERRED_WAKE_REVISIT_COOLDOWN_MS);
}

/** Whether a wake last looked at at `lastSeenAt` is due for another look. */
export function isDeferredWakeRevisitDue(lastSeenAt: Date | null | undefined, nowMs: number): boolean {
  if (!lastSeenAt) return true;
  return lastSeenAt.getTime() <= deferredWakeRevisitCutoff(nowMs).getTime();
}
