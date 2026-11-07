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
// one issue gets at most one such wake per 30 minutes. The check reads the
// wake requests the board already keeps (`agent_wakeup_requests`: reason plus
// payload `issueId`, `skipped` ones never ran and do not count); the idempotency
// key (one per stopped run) makes the wake queue itself refuse an exact replay.

import { and, eq, gte, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, type Db } from "@myrmidon/db";
import { isAgentStatusInvokable } from "@myrmidon/shared";

export const RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON = "run_guard_stop_needs_input";
export const RUN_GUARD_STOP_NEEDS_INPUT_SOURCE = "myrmidon.run_guard_stop_needs_input";
/** One wake per issue within this window, whatever agent it went to. */
export const RUN_GUARD_STOP_WAKE_DEDUP_WINDOW_MS = 30 * 60 * 1000;
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

export function buildRunGuardStopWakeIdempotencyKey(input: { issueId: string; runId: string }): string {
  return `${RUN_GUARD_STOP_NEEDS_INPUT_SOURCE}:${input.issueId}:${input.runId}`;
}

/**
 * The agent to wake: the assignee's `reports_to` when it is another invokable agent of
 * the company, else the invokable agent named `adm`, else null (nobody is woken).
 * The assignee itself is never the recipient.
 */
export async function resolveRunGuardStopWakeTargetId(db: Db, issue: EscalationIssue): Promise<string | null> {
  if (!issue.assigneeAgentId) return null;
  const [assignee] = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    .limit(1);
  if (!assignee) return null;
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

/** True when this issue already had a `run_guard_stop_needs_input` wake within the window. */
export async function hasRecentRunGuardStopWake(
  db: Db,
  input: { companyId: string; issueId: string; now?: Date },
): Promise<boolean> {
  const since = new Date((input.now ?? new Date()).getTime() - RUN_GUARD_STOP_WAKE_DEDUP_WINDOW_MS);
  const rows = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.reason, RUN_GUARD_STOP_NEEDS_INPUT_WAKE_REASON),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${input.issueId}`,
        gte(agentWakeupRequests.requestedAt, since),
        ne(agentWakeupRequests.status, "skipped"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Wake the manager of a task whose run the guard stopped for good. Returns the id of
 * the agent woken, or null when nobody was (no recipient, or the issue was woken for
 * within the last 30 minutes). `stopReason` and `stopText` travel in the payload so the
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
    now?: Date;
  },
): Promise<string | null> {
  const { issue, latestRun } = input;
  if (await hasRecentRunGuardStopWake(db, { companyId: issue.companyId, issueId: issue.id, now: input.now })) {
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
