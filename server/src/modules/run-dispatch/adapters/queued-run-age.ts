import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@myrmidon/db";

// myrmidon(OPE-11947): SQL twin of `queuedRunWaitingSince`
// (../domain/queued-run-age.ts). True when the run has waited for its start at
// least `staleAfterMs` at `now`: a run with a `scheduled_retry_at` that is
// already due waits since that time, any other run since `created_at`.
export function queuedRunWaitedAtLeastSql(now: Date, staleAfterMs: number): SQL {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - staleAfterMs).toISOString();
  // myrmidon(RESUME-QUEUE-AGE): the resume stamp (`context_snapshot.queueWaitResumedAt`,
  // an ISO instant written by pause-drain.ts) moves the start of the wait later;
  // a value that is not an ISO instant, or lies in the future, is ignored.
  const base = sql`(case when ${heartbeatRuns.scheduledRetryAt} is not null and ${heartbeatRuns.scheduledRetryAt} <= ${nowIso}::timestamptz then ${heartbeatRuns.scheduledRetryAt} else ${heartbeatRuns.createdAt} end)`;
  const stamp = sql`(case when ${heartbeatRuns.contextSnapshot}->>'queueWaitResumedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$' then (${heartbeatRuns.contextSnapshot}->>'queueWaitResumedAt')::timestamptz else null end)`;
  return sql`(case when ${stamp} is not null and ${stamp} <= ${nowIso}::timestamptz and ${stamp} > ${base} then ${stamp} else ${base} end) <= ${cutoffIso}::timestamptz`;
}
