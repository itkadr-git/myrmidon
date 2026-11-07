// myrmidon(RUN-GUARD-ESCALATE): who hears about a task the run guard stopped for good.
//
// A final guard stop (see run-guard-stop.ts) moves the assignee's task to
// `blocked` with a comment that asks for a new input. Nobody was woken by it,
// so the task sat blocked until someone happened to read the comment. This
// module wakes the assignee's manager (`agents.reports_to`; without a usable
// one, the agent named `adm`) with the wake reason `run_guard_stop_needs_input`.
// The assignee and the status are left as the escalation set them: the manager
// reads the last run, writes the point of the fix into the task or splits it,
// and puts it back to `todo` (skills/myrmidon, wake reasons).
//
// A task that keeps hitting the guard must not wake its manager in a loop, so
// one block episode gets one such wake: the manager is skipped when the task
// has not left `blocked` since the previous wake (no `issue.updated` activity
// that moves the status away from `blocked` after the wake). Once the manager
// (or anybody) put the task back, the next stop is a new episode and wakes the
// manager again at once, however soon. The check reads the wake requests the
// board already keeps (`agent_wakeup_requests`: reason plus payload `issueId`,
// `skipped` ones never ran and do not count) and the activity log; the
// idempotency key (one per stopped run) makes the wake queue itself refuse an
// exact replay.
//
// When the assignee is the agent `adm` itself, nobody is woken: `adm` is the
// last link of the chain and there is no one above it to give it a new input.

import { and, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, type Db } from "@myrmidon/db";
import { isAgentStatusInvokable } from "@myrmidon/shared";

export const RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON = "run_guard_stop_needs_input";
export const RUN_GUARD_STOP_NEEDS_INPUT_SOURCE = "myrmidon.run_guard_stop_needs_input";
/** Name of the fallback recipient when the assignee has no usable manager. */
export const RUN_GUARD_STOP_FALLBACK_AGENT_NAME = "adm";

interface EscalationIssue {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
}

interface EscalationRun {
  id: string;
  errorCode?: string | null;
  resultJson?: unknown;
}

type EnqueueWakeup = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    requestedByActorType: "system";
    requestedByActorId: null;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

function isFallbackAgentName(name: string | null | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === RUN_GUARD_STOP_FALLBACK_AGENT_NAME;
}

export function buildRunGuardStopWakeIdempotencyKey(input: { issueId: string; runId: string }): string {
  return `${RUN_GUARD_STOP_NEEDS_INPUT_SOURCE}:${input.issueId}:${input.runId}`;
}

/**
 * The agent to wake: the assignee's `reports_to` when it is another invokable agent of
 * the company, else the invokable agent named `adm`, else null (nobody is woken).
 * The assignee itself is never the recipient, and an assignee that is `adm` itself has
 * nobody above it: null.
 */
export async function resolveRunGuardStopWakeTargetId(db: Db, issue: EscalationIssue): Promise<string | null> {
  if (!issue.assigneeAgentId) return null;
  const [assignee] = await db
    .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
    .from(agents)
    .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    .limit(1);
  if (!assignee || isFallbackAgentName(assignee.name)) return null;
  if (assignee.reportsTo && assignee.reportsTo !== assignee.id) {
    const [manager] = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, assignee.reportsTo), eq(agents.companyId, issue.companyId)))
      .limit(1);
    if (manager && isAgentStatusInvokable(manager.status)) return manager.id;
  }
  const fallbacks = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, issue.companyId),
        sql`lower(btrim(${agents.name})) = ${RUN_GUARD_STOP_FALLBACK_AGENT_NAME}`,
      ),
    );
  const fallback = fallbacks.find((row) => row.id !== assignee.id && isAgentStatusInvokable(row.status));
  return fallback?.id ?? null;
}

/**
 * True when `agentId` is a legitimate recipient of the wake for this issue: the
 * assignee's `reports_to`, or the agent named `adm` (never the assignee itself). The
 * run dispatch asks it before it lets a non-assignee run start on the assignee's issue.
 */
export async function isRunGuardStopWakeRecipient(
  db: Db,
  input: { companyId: string; assigneeAgentId: string | null; agentId: string },
): Promise<boolean> {
  if (!input.assigneeAgentId || input.assigneeAgentId === input.agentId) return false;
  const rows = await db
    .select({ id: agents.id, name: agents.name, reportsTo: agents.reportsTo })
    .from(agents)
    .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, [input.assigneeAgentId, input.agentId])));
  const assignee = rows.find((row) => row.id === input.assigneeAgentId);
  const candidate = rows.find((row) => row.id === input.agentId);
  if (!assignee || !candidate || isFallbackAgentName(assignee.name)) return false;
  return assignee.reportsTo === candidate.id || isFallbackAgentName(candidate.name);
}

/**
 * True when the manager was already woken for the current block episode of this issue:
 * there is a `run_guard_stop_needs_input` wake for it and the issue has not left
 * `blocked` since (no `issue.updated` activity that moves the status away from
 * `blocked`, dated after the wake).
 */
export async function hasRunGuardStopWakeInBlockEpisode(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<boolean> {
  const [last] = await db
    .select({ requestedAt: agentWakeupRequests.requestedAt })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        ne(agentWakeupRequests.status, "skipped"),
      ),
    )
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  if (!last) return false;
  const [left] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, "issue.updated"),
        gt(activityLog.createdAt, last.requestedAt),
        // The three shapes that issue status changes are logged in: the route's `changes`,
        // its `_previous`, and the system paths' `previousStatus`.
        sql`(
          ${activityLog.details} #>> '{changes,status,from}' = 'blocked'
          or ${activityLog.details} #>> '{_previous,status}' = 'blocked'
          or ${activityLog.details} ->> 'previousStatus' = 'blocked'
        )`,
      ),
    )
    .limit(1);
  return !left;
}

/**
 * Wake the manager of a task whose run the guard stopped for good. Returns the id of
 * the agent woken, or null when nobody was (no recipient, or the issue was woken for
 * in the current block episode). `stopReason` and `stopText` travel in the payload so the
 * manager sees why without opening the run.
 */
export async function wakeManagerForRunGuardStop(
  db: Db,
  enqueueWakeup: EnqueueWakeup,
  input: {
    issue: EscalationIssue;
    latestRun: EscalationRun;
    stopReason: string | null;
    stopText: string | null;
  },
): Promise<string | null> {
  const { issue, latestRun } = input;
  if (await hasRunGuardStopWakeInBlockEpisode(db, { companyId: issue.companyId, issueId: issue.id })) {
    return null;
  }
  const targetId = await resolveRunGuardStopWakeTargetId(db, issue);
  if (!targetId) return null;
  const stop = { runId: latestRun.id, reason: input.stopReason, text: input.stopText };
  await enqueueWakeup(targetId, {
    source: "automation",
    triggerDetail: "system",
    reason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
    payload: {
      issueId: issue.id,
      assigneeAgentId: issue.assigneeAgentId,
      runGuardStop: stop,
    },
    idempotencyKey: buildRunGuardStopWakeIdempotencyKey({ issueId: issue.id, runId: latestRun.id }),
    requestedByActorType: "system",
    requestedByActorId: null,
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      wakeReason: RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON,
      source: RUN_GUARD_STOP_NEEDS_INPUT_SOURCE,
      runGuardStop: stop,
    },
  });
  return targetId;
}
