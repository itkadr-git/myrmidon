import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@myrmidon/db";

// myrmidon(OPE-11947): SQL twin of `queuedRunWaitingSince`
// (../domain/queued-run-age.ts). True when the run has waited for its start at
// least `staleAfterMs` at `now`: a run with a `scheduled_retry_at` that is
// already due waits since that time, any other run since `created_at`.
export function queuedRunWaitedAtLeastSql(now: Date, staleAfterMs: number): SQL {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - staleAfterMs).toISOString();
  return sql`(case when ${heartbeatRuns.scheduledRetryAt} is not null and ${heartbeatRuns.scheduledRetryAt} <= ${nowIso}::timestamptz then ${heartbeatRuns.scheduledRetryAt} else ${heartbeatRuns.createdAt} end) <= ${cutoffIso}::timestamptz`;
}
