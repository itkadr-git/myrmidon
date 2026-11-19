// myrmidon(OPE-11948): automatic `issue_continuation_needed` wakes are for an
// issue that can be worked on right now, and a loop of them is bounded by a
// counter the agent's own activity cannot reset.
//
// Production fact (06.11): ~22% of all engineer wakes were continuation wakes
// for issues parked in `backlog` / `blocked`, one every 1-9 minutes, and
// `heartbeat_runs.continuation_attempt` stayed 0 on every run. The run's own
// comment, its own status update and board bookkeeping were classified as
// progress (`liveness_state = advanced`), which resets the vendor attempt
// counter, so neither the max-attempts guard nor the rewake throttle ever
// stopped the loop.
//
// Two rules, both applied at the single place where the continuation wake is
// admitted (`enqueueWakeup` in services/heartbeat.ts, under the issue lock):
//   1. Status gate: only a `todo` / `in_progress` issue assigned to the woken
//      agent is continued. The dispatcher applies the status half again to a
//      queued run (run-dispatch/domain/policy.ts), so a stale queued wake dies.
//      A continuation that answers a resolved interaction card (a person
//      accepted a plan or answered a question) is human-driven: it may also run
//      `in_review`, and the cap does not count it.
//   2. Real cap: after MAX_CONTINUATIONS_WITHOUT_EXTERNAL_INPUT succeeded
//      continuation runs of the same (agent, issue) with no external input
//      between them, no further continuation is enqueued and the issue is
//      moved to `blocked` with a system comment until an external event
//      arrives.
//
// "External input" reuses the movement notion of the cooling guard
// (wake-task-guard.ts `isRealTaskMovement`): a comment or a movement activity
// by a user or by a different agent, a blocker resolved, a PR/CI sync event.
// A change of the PR head (`issue.work_product_head_changed`) counts too.
// The agent's own comments and updates and system bookkeeping do not count.

import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, type Db } from "@myrmidon/db";
import type { IssueBlockerMetadata, IssueUnblockDescriptor } from "@myrmidon/shared";
import {
  EXTERNAL_SYSTEM_MOVEMENTS,
  MOVEMENT_ACTIVITY_ACTIONS,
  isRealTaskMovement,
  type TaskMovement,
} from "./wake-task-guard.js";
import { PR_HEAD_CHANGE_ACTIVITY_ACTION } from "../services/issue-rewake-throttle.js";

export const CONTINUATION_WAKE_REASON = "issue_continuation_needed";

/** The only statuses an automatic continuation may run in. */
export const CONTINUATION_ACTIONABLE_STATUSES = ["todo", "in_progress"] as const;

/**
 * A continuation that answers a resolved interaction card (a person accepted a
 * plan or answered a question) is human-driven, and `in_review` is where such a
 * task waits for that answer, so it may run there as well.
 */
export const CONTINUATION_INTERACTION_STATUSES = ["todo", "in_progress", "in_review"] as const;

/** Succeeded continuation runs in a row, without external input, before the stop. */
export const MAX_CONTINUATIONS_WITHOUT_EXTERNAL_INPUT = 3;
export const CONTINUATION_CAP_COOLDOWN_MS = 60 * 60 * 1000;

/** How long the stop block holds before the board janitor may look at it again. */
export const CONTINUATION_CAP_BLOCK_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const CONTINUATION_CAP_BLOCK_CHECK_MS = 24 * 60 * 60 * 1000;
export const CONTINUATION_CAP_ESCALATION_POLICY = "continuation_cap_v1";

export const CONTINUATION_CAP_COMMENT =
  "Остановлено: 3 продолжения подряд без внешнего события. " +
  "Нужна новая вводная (комментарий, снятие блокера) — после неё задача продолжится.";
export const CONTINUATION_CAP_UNBLOCK_ACTION =
  "Дать новую вводную по задаче (комментарий или снятие блокера): автоматические продолжения остановлены";

/** Movement actions that count as external input: the cooling guard's list plus an assignment. */
const EXTERNAL_INPUT_ACTIVITY_ACTIONS: string[] = [...MOVEMENT_ACTIVITY_ACTIONS, "issue.assigned"];
// A change of the head of the task's pull request (a push the webhook saw) is
// real progress outside the agent's own chatter, so it restarts the count. It
// is local to this cap: the cooling guard's movement list is left as it was.
const EXTERNAL_INPUT_SYSTEM_ACTIONS: string[] = [...EXTERNAL_SYSTEM_MOVEMENTS, PR_HEAD_CHANGE_ACTIVITY_ACTION];

function isExternalInput(move: TaskMovement, agentId: string): boolean {
  if (isRealTaskMovement(move, agentId)) return true;
  return move.actorType === "system" && move.action === PR_HEAD_CHANGE_ACTIVITY_ACTION;
}

export interface ContinuationIssueFacts {
  status: string;
  assigneeAgentId: string | null;
}

/** The statuses an automatic continuation may run in; `interaction` is a wake that carries a resolved card. */
export function continuationStatusesFor(interaction: boolean): readonly string[] {
  return interaction ? CONTINUATION_INTERACTION_STATUSES : CONTINUATION_ACTIONABLE_STATUSES;
}

/** True when an automatic continuation wake for `agentId` may be admitted on this issue. */
export function isContinuationActionable(
  issue: ContinuationIssueFacts,
  agentId: string,
  options: { interaction?: boolean } = {},
): boolean {
  return (
    continuationStatusesFor(options.interaction === true).includes(issue.status) &&
    issue.assigneeAgentId === agentId
  );
}

/**
 * Pure counter. `runs` are the succeeded continuation runs of one (agent,
 * issue), newest first; `moves` are candidate movements after the oldest of
 * them. A run counts while it was created after the latest external movement,
 * so an external event between two runs starts the count over. Interleaved
 * runs of other kinds are ignored on purpose: the cap must hold even when an
 * idle pickup sits between two continuations.
 */
export function countContinuationsWithoutExternalInput(input: {
  agentId: string;
  runs: ReadonlyArray<{ createdAt: Date }>;
  moves: ReadonlyArray<TaskMovement>;
}): number {
  let lastExternalAt = Number.NEGATIVE_INFINITY;
  for (const move of input.moves) {
    if (isExternalInput(move, input.agentId) && move.at > lastExternalAt) lastExternalAt = move.at;
  }
  let count = 0;
  for (const run of input.runs) {
    if (run.createdAt.getTime() <= lastExternalAt) break;
    count += 1;
  }
  return count;
}

/** An issue whose continuation cap was reached inside a wake admission. */
export interface ContinuationCapStop {
  companyId: string;
  issueId: string;
  agentId: string;
  consecutiveContinuations: number;
}

export interface ContinuationCapReading {
  /** Counted continuation runs; exact only once the cap is reached or the history is shorter. */
  count: number;
  max: number;
  capped: boolean;
}

/**
 * Latest external movement on the issue after `since`: one comment by a user or
 * another agent, and one movement activity by a user, another agent, or a
 * system actor naming an external event (blocker resolved, PR/CI sync).
 */
async function loadExternalMovements(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; since: Date; ignoreActions?: readonly string[] },
): Promise<TaskMovement[]> {
  const comments = await db
    .select({
      at: issueComments.createdAt,
      authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        gt(issueComments.createdAt, input.since),
        isNull(issueComments.deletedAt),
        or(
          // A comment a board credential posted on behalf of this very agent
          // (derived author) is the agent's own, not a person's.
          and(
            isNotNull(issueComments.authorUserId),
            or(isNull(issueComments.derivedAuthorAgentId), ne(issueComments.derivedAuthorAgentId, input.agentId)),
          ),
          and(isNotNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.agentId)),
        ),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1);
  const acts = await db
    .select({
      at: activityLog.createdAt,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      action: activityLog.action,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        gt(activityLog.createdAt, input.since),
        // The system actions of the list below must pass this filter too: a
        // row the filter drops never reaches the `or` branch (the PR head
        // change was dropped here, so a push did not reset the count).
        inArray(
          activityLog.action,
          [...new Set([...EXTERNAL_INPUT_ACTIVITY_ACTIONS, ...EXTERNAL_INPUT_SYSTEM_ACTIONS])].filter(
            (action) => !input.ignoreActions?.includes(action),
          ),
        ),
        or(
          eq(activityLog.actorType, "user"),
          and(eq(activityLog.actorType, "agent"), ne(activityLog.actorId, input.agentId)),
          and(
            notInArray(activityLog.actorType, ["user", "agent"]),
            inArray(activityLog.action, EXTERNAL_INPUT_SYSTEM_ACTIONS),
          ),
        ),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const out: TaskMovement[] = [];
  for (const c of comments) {
    if (c.authorUserId) out.push({ at: c.at.getTime(), actorType: "user", actorId: c.authorUserId });
    else if (c.authorAgentId) out.push({ at: c.at.getTime(), actorType: "agent", actorId: c.authorAgentId });
  }
  for (const a of acts) {
    const actorType = a.actorType === "user" || a.actorType === "agent" ? a.actorType : "system";
    out.push({ at: a.at.getTime(), actorType, actorId: a.actorId, action: a.action });
  }
  return out;
}

/**
 * Reads the real attempt counter for one (agent, issue). Only `succeeded`
 * continuation runs count: a failed or timed-out continuation is already
 * bounded by the failure retry budget and its own escalation, and a cancelled
 * one did no work. The run identity is the persisted wake reason, which both
 * producers (the recovery sweep and the release recovery tail) write.
 */
export async function readContinuationCap(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; max?: number },
): Promise<ContinuationCapReading> {
  const max = input.max ?? MAX_CONTINUATIONS_WITHOUT_EXTERNAL_INPUT;
  const runs = await db
    .select({ createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        // The expression matches heartbeat_runs_company_ctx_issue_created_idx.
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        eq(heartbeatRuns.status, "succeeded"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'wakeReason' = ${CONTINUATION_WAKE_REASON}`,
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(max);
  if (runs.length < max) return { count: runs.length, max, capped: false };
  const moves = await loadExternalMovements(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    since: runs[runs.length - 1]!.createdAt,
  });
  const count = countContinuationsWithoutExternalInput({ agentId: input.agentId, runs, moves });
  return {
    count,
    max,
    capped: count >= max && Date.now() < runs[0]!.createdAt.getTime() + CONTINUATION_CAP_COOLDOWN_MS,
  };
}

/** Activity the stop writes when it parks an issue. */
export const CONTINUATION_CAP_STOP_ACTIVITY_ACTION = "issue.continuation_cap_reached";

/**
 * True while the issue sits in a continuation stop: the latest stop record is
 * for this agent and no external input came after it. External input is the
 * same notion the cap counts (a comment or movement by a user or another
 * agent, a PR/CI sync event, a PR head change), plus a blocker closed after
 * the stop (`blockersResolvedAt`). The wake the dependency backstop emitted
 * itself is not input: it is the producer of the loop, so it is ignored here.
 * A change of assignee leaves the stop at once (the stop belongs to one agent).
 */
export async function isIssueInContinuationStop(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; blockersResolvedAt?: Date | null },
): Promise<boolean> {
  const [stop] = await db
    .select({ at: activityLog.createdAt, agentId: activityLog.agentId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, CONTINUATION_CAP_STOP_ACTIVITY_ACTION),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  if (!stop || stop.agentId !== input.agentId) return false;
  if (input.blockersResolvedAt && input.blockersResolvedAt.getTime() > stop.at.getTime()) return false;
  const moves = await loadExternalMovements(db, {
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    since: stop.at,
    ignoreActions: ["issue.blockers_resolved_wake_emitted"],
  });
  return !moves.some((move) => isExternalInput(move, input.agentId));
}

/**
 * Patch that parks the issue after the cap: `blocked` with a stated reason
 * (the issue service refuses a reasonless block). `human_decision` keeps the
 * recovery sweep's restore of review blocks and the board janitor away from
 * it; the board-owned unblock descriptor surfaces it in the inbox.
 */
export function buildContinuationCapBlockedPatch(input: {
  issueId: string;
  assigneeAgentId: string;
  ownerUserId?: string | null;
  now?: Date;
}): { status: "blocked"; blockerMetadata: IssueBlockerMetadata; unblockDescriptor: IssueUnblockDescriptor } {
  const now = input.now ?? new Date();
  const timeoutAt = new Date(now.getTime() + CONTINUATION_CAP_BLOCK_TIMEOUT_MS).toISOString();
  return {
    status: "blocked",
    blockerMetadata: {
      blockReason: "human_decision",
      owner: input.ownerUserId ? { userId: input.ownerUserId } : { agentId: input.assigneeAgentId },
      externalRef: `continuation_cap:${input.issueId}`,
      nextCheckAt: new Date(now.getTime() + CONTINUATION_CAP_BLOCK_CHECK_MS).toISOString(),
      timeoutAt,
      escalationPolicy: CONTINUATION_CAP_ESCALATION_POLICY,
    },
    unblockDescriptor: {
      owner: "board",
      action: CONTINUATION_CAP_UNBLOCK_ACTION,
      reasonRef: { kind: "event", eventKey: `continuation.cap:${input.issueId}`, dueAt: timeoutAt },
    },
  };
}
