import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@myrmidon/db";

// myrmidon(OPE-11947): SQL twin of `queuedRunWaitingSince`
// (../domain/queued-run-age.ts). True when the run has waited for its start at
// least `staleAfterMs` at `now`: a run with a `scheduled_retry_at` that is
// already due waits since that time, any other run since `created_at`.
export function queuedRunWaitedAtLeastSql(now: Date, staleAfterMs: number): SQL {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - staleAfterMs).toISOString();
  // myrmidon(RESUME-QUEUE-AGE): the resume stamp (`context_snapshot.queueWaitResumedAtMs`,
  // epoch milliseconds written by pause-drain.ts) moves the start of the wait later.
  // The accepted set equals the TS rule (../domain/queued-run-age.ts): a JSON number,
  // an integer, 12..14 digits; anything else (absent, null, string, negative,
  // fractional, too long, in the future) is ignored. The nested CASEs keep the
  // casts from running on a value that is not a number, so no value raises.
  const raw = sql`(${heartbeatRuns.contextSnapshot}->>'queueWaitResumedAtMs')`;
  const stamp = sql`(case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'queueWaitResumedAtMs') = 'number' then (case when ${raw}::numeric between 100000000000 and 99999999999999 and ${raw}::numeric = trunc(${raw}::numeric) then to_timestamp(${raw}::numeric / 1000.0) else null end) else null end)`;
  const base = sql`(case when ${heartbeatRuns.scheduledRetryAt} is not null and ${heartbeatRuns.scheduledRetryAt} <= ${nowIso}::timestamptz then ${heartbeatRuns.scheduledRetryAt} else ${heartbeatRuns.createdAt} end)`;
  return sql`(case when ${stamp} is not null and ${stamp} <= ${nowIso}::timestamptz and ${stamp} > ${base} then ${stamp} else ${base} end) <= ${cutoffIso}::timestamptz`;
}
