// myrmidon(PR-WAIT-MONITOR, OPE-11949): the one database read the pure policy
// needs besides the work products - when the agent last looked at the task.

import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@myrmidon/db";

const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "scheduled_retry"]);

/**
 * The end of the agent's latest run on the task, or `now` while that run is
 * live (an agent that is running looks at the task right now). Null when the
 * agent never ran on the task. The read uses the (company, issue, created_at)
 * index of heartbeat_runs and fetches one row.
 */
export async function readAgentLastLookAt(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string; now: Date },
): Promise<Date | null> {
  const run = await db
    .select({
      status: heartbeatRuns.status,
      finishedAt: heartbeatRuns.finishedAt,
      updatedAt: heartbeatRuns.updatedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) return null;
  if (LIVE_RUN_STATUSES.has(run.status)) return input.now;
  return run.finishedAt ?? run.updatedAt ?? run.createdAt;
}
