// myrmidon(OPE-6954): a task an actor returned to the ready queue is not the
// stopped execution's live context.
//
// `settleUnrecoverableExecutions` projects a stopped run onto `blocked` while
// the task still looks like that run's context: not done/cancelled, the same
// assignee, no newer execution. A status the board set *after* the failure is
// not that context — re-queuing a stuck task is how the queue is refilled, and
// the closure used to overwrite it. In OPE-6324 the lead's two PATCHes to
// `todo` (22:08 and 23:02 UTC) were both reverted to `blocked` (22:10:13 and
// 23:05:20 UTC) by `execution-recovery`, with `blockedBy` empty and no run:
// the task could not be put back to work at all.
//
// The closure still records the settled "do not replay" hold
// (`evidence.automaticRecovery.replay = "blocked"`, so nothing replays and the
// wake admission keeps parking non-explicit wakes); it only leaves the status
// alone. Lifting that hold stays where it was: an explicitly authorized wake
// (L2) or a person's unblock (HOLD-READY, which also accepts a person starting
// a held task that already sits in a workable status).
// See docs/myrmidon/DIVERGENCE.md "REQUEUE-HOLD".
/** Statuses where a task waits in the queue instead of being executed. */
export const READY_QUEUE_STATUSES = ["backlog", "todo"] as const;

export function isReadyQueueStatus(status: string): boolean {
  return (READY_QUEUE_STATUSES as readonly string[]).includes(status);
}

/** Note of a closure that left the ready status an actor had set. */
export const REQUEUED_HOLD_NOTE =
  "Recovery closed because the task was returned to the ready queue after the run stopped. Recorded work is preserved; nothing is replayed.";
