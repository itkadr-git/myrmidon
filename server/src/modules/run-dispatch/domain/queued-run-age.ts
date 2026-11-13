// myrmidon(OPE-11947): the moment a queued run began to wait for its start.
//
// A scheduled retry is created right after the failure it answers, in
// `scheduled_retry`, and enters the queue (`queued`) only when its
// `scheduled_retry_at` falls due; `scheduled_retry_at` survives the promotion.
// The stale-queued-run check measured age from `created_at`, so a retry with a
// delay longer than the stale threshold (model-unavailable waits: 30 min, 1 h,
// 2 h, 4 h, 6 h) was already "stale" the instant it was promoted and was
// cancelled at once, which restarted the whole retry chain from attempt 0.
//
// Rule: a run that carries a `scheduled_retry_at` already in the past waits
// since that time; every other run waits since `created_at`. A
// `scheduled_retry_at` in the future (a queued run cannot have one: the
// promotion requires it to be due) falls back to `created_at`, the old rule.
// The SQL twin of this rule is `queuedRunWaitedAtLeastSql`
// (../adapters/queued-run-age.ts); keep the two in step.

//
// myrmidon(RESUME-QUEUE-AGE): a run that stood in the queue while its agent was
// paused did not wait for a start during the pause: the agent could not start
// anything. The resume stamps the agent's queued runs with
// `contextSnapshot.queueWaitResumedAt` (myrmidon/pause-drain.ts), and the wait
// counts from that moment when it is later than the rule above. A stamp in the
// future (or one that is not a date) is ignored. SQL twin: same file in
// ../adapters/queued-run-age.ts.
export const QUEUE_WAIT_RESUMED_AT_KEY = "queueWaitResumedAt";

export function queuedRunWaitingSince(
  run: { createdAt: Date; scheduledRetryAt?: Date | string | null; contextSnapshot?: unknown },
  now: Date,
): Date {
  let since = run.createdAt;
  if (run.scheduledRetryAt != null) {
    const dueAt = new Date(run.scheduledRetryAt);
    if (Number.isFinite(dueAt.getTime()) && dueAt.getTime() <= now.getTime()) since = dueAt;
  }
  const snapshot = run.contextSnapshot;
  const stamp =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)[QUEUE_WAIT_RESUMED_AT_KEY]
      : null;
  if (typeof stamp === "string") {
    const resumedAt = new Date(stamp);
    if (
      Number.isFinite(resumedAt.getTime()) &&
      resumedAt.getTime() <= now.getTime() &&
      resumedAt.getTime() > since.getTime()
    ) {
      since = resumedAt;
    }
  }
  return since;
}
