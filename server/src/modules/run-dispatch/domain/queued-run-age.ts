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

export function queuedRunWaitingSince(
  run: { createdAt: Date; scheduledRetryAt?: Date | string | null },
  now: Date,
): Date {
  if (run.scheduledRetryAt != null) {
    const dueAt = new Date(run.scheduledRetryAt);
    if (Number.isFinite(dueAt.getTime()) && dueAt.getTime() <= now.getTime()) return dueAt;
  }
  return run.createdAt;
}
