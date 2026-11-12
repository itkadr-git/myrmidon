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
 */
export const DEFERRED_WAKE_REVISIT_COOLDOWN_MS = 5 * 60_000;

/** Latest `updatedAt` a wake may carry to be due for another look. */
export function deferredWakeRevisitCutoff(nowMs: number): Date {
  return new Date(nowMs - DEFERRED_WAKE_REVISIT_COOLDOWN_MS);
}

/** Whether a wake last looked at at `lastSeenAt` is due for another look. */
export function isDeferredWakeRevisitDue(lastSeenAt: Date | null | undefined, nowMs: number): boolean {
  if (!lastSeenAt) return true;
  return lastSeenAt.getTime() <= deferredWakeRevisitCutoff(nowMs).getTime();
}
