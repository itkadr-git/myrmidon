import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { activityLog, agentWakeupRequests, agents, issueComments, projects } from "@myrmidon/db";

// myrmidon(UNBLOCK-REQUEST-NO-SELF-WAKE): database lookups behind the unblock
// request throttle. No schema changes: the previous wake is read from
// agent_wakeup_requests, external events from comments and activity.

export async function findLastUnblockRequestWakeAt(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<Date | null> {
  const [row] = await db
    .select({ requestedAt: agentWakeupRequests.requestedAt })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.reason, "issue_unblock_requested"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  return row?.requestedAt ?? null;
}

/** Latest comment by someone other than the given agents, or blocker change. */
export async function findLastExternalIssueEventAt(
  db: Db,
  input: { companyId: string; issueId: string; ignoreAgentIds: string[] },
): Promise<Date | null> {
  const ignore = input.ignoreAgentIds.filter(Boolean);
  const [comment] = await db
    .select({ createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        or(isNull(issueComments.authorType), ne(issueComments.authorType, "system")),
        ignore.length > 0
          ? or(isNull(issueComments.authorAgentId), notInArray(issueComments.authorAgentId, ignore))
          : undefined,
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1);
  const [blockers] = await db
    .select({ createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityId, input.issueId),
        inArray(activityLog.action, ["issue.blockers.updated", "issue.blockers_updated"]),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const times = [comment?.createdAt, blockers?.createdAt].filter((v): v is Date => Boolean(v));
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

/** Project lead, else the assignee's manager. Null when the board has none. */
export async function resolveUnblockEscalationAgentId(
  db: Db,
  input: { companyId: string; projectId: string | null; assigneeAgentId: string },
): Promise<string | null> {
  if (input.projectId) {
    const [project] = await db
      .select({ leadAgentId: projects.leadAgentId })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
      .limit(1);
    if (project?.leadAgentId && project.leadAgentId !== input.assigneeAgentId) return project.leadAgentId;
  }
  const [agent] = await db
    .select({ reportsTo: agents.reportsTo })
    .from(agents)
    .where(and(eq(agents.id, input.assigneeAgentId), eq(agents.companyId, input.companyId)))
    .limit(1);
  return agent?.reportsTo ?? null;
}
