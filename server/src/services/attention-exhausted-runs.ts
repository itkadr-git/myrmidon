import { and, asc, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

export type AttentionExhaustedRunsOptions = {
  /**
   * attention-latency fix (A1): when set, only runs created after this instant are
   * considered. Without it the query scans every unresolved failed run of the
   * company since the beginning of time, and the window grows with the age of
   * the oldest failure (months on production volume).
   */
  createdAtAfter?: Date;
};

export function listAttentionExhaustedRuns(
  db: Db,
  companyId: string,
  options: AttentionExhaustedRunsOptions = {},
) {
  // Recovery can revisit an exhausted run. Deduplicate its historical events
  // before joining run data so duplicate events never multiply the wire payload.
  const latestExhaustion = db
    .selectDistinctOn([heartbeatRunEvents.runId], {
      runId: heartbeatRunEvents.runId,
      eventId: heartbeatRunEvents.id,
      message: heartbeatRunEvents.message,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.eventType, "lifecycle"),
      sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
    ))
    .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id))
    .as("latest_exhaustion");

  return db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      status: heartbeatRuns.status,
      error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode,
      // Thin columns with a snapshot coalesce for historical rows (OPE-5007 П2):
      // the feed needs the two ids only and must not detoast the run context.
      runIssueId: sql<string | null>`coalesce(${heartbeatRuns.contextIssueId}, ${heartbeatRuns.contextSnapshot} ->> 'issueId')`,
      runTaskId: sql<string | null>`coalesce(${heartbeatRuns.contextTaskId}, ${heartbeatRuns.contextSnapshot} ->> 'taskId')`,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      finishedAt: heartbeatRuns.finishedAt,
      exhaustionMessage: latestExhaustion.message,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(latestExhaustion, eq(latestExhaustion.runId, heartbeatRuns.id))
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(agents.companyId, companyId),
      notInArray(agents.status, ["terminated"]),
      inArray(heartbeatRuns.status, ["failed", "timed_out"]),
      // Failures older than the horizon never enter the feed.
      ...(options.createdAtAfter ? [gt(heartbeatRuns.createdAt, options.createdAtAfter)] : []),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(latestExhaustion.eventId));
}
