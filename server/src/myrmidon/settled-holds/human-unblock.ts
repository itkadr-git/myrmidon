// myrmidon(HOLD-READY): a person unblocking an issue lifts its settled
// "do not replay" hold.
//
// A closed (resolved/cancelled) recovery action whose
// `evidence.automaticRecovery.replay` reads "blocked" holds the issue for good:
// the wake admission parks every non-explicit wake of the issue as
// `deferred_issue_execution` (`payload.executionWait`), and the wakes a board
// PATCH sends — the status-change wake and the comment wake — are not explicit
// (settled-holds/wake-classification.ts), so they were parked too. Moving the
// issue out of `blocked` or reassigning it is exactly the operator's "carry
// on"; it now acts as the operator resolve it is (the same
// `clearSettledReplayBlock` the board's `recovery-actions/resolve` uses),
// inside the PATCH's own transaction. The wakes parked on the hold are
// re-planned after commit: one fresh wake for the assignee re-enters the
// ordinary admission, which (with no hold left) adopts the parked comment
// wakes into the new run (heartbeat.ts `adoptedComments`); any other parked
// wake is drained behind that run by the vendor release path.
// See docs/myrmidon/DIVERGENCE.md "HOLD-READY".
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, issueRecoveryActions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { ActivityPublication } from "../../services/activity-log.js";
import { executionBlockerPredicate, getExecutionBlocker } from "../../services/execution-blocker.js";
import { clearSettledReplayBlock } from "./clear.js";

/** Statuses an issue can be unblocked into: the ones an agent works in. */
const WORKABLE_STATUSES = ["todo", "in_progress"] as const;

export const HUMAN_UNBLOCK_REPLAN_REASON = "execution_hold_cleared";
export const HUMAN_UNBLOCK_NOTE =
  "Cleared by a board operator unblocking the issue (moved out of blocked or reassigned).";

interface IssueSide {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

interface UnblockActor {
  /** `req.actor.type`: only a board actor is a person here. */
  requestActorType: string;
  /** A board request that carries a run id is an agent's run acting through the board. */
  runId: string | null | undefined;
}

/**
 * Cheap pre-check from the request alone: could this PATCH be a person
 * unblocking the issue? The PATCH route uses it to run the update in a
 * transaction, so the hold is cleared atomically with the status change.
 */
export function mayBeHumanUnblock(input: UnblockActor & {
  existingStatus: string;
  assigneeChangeRequested: boolean;
}): boolean {
  if (input.requestActorType !== "board" || input.runId) return false;
  return input.existingStatus === "blocked" || input.assigneeChangeRequested;
}

/**
 * The decision on the committed row: a board person (no run) moved the issue
 * out of `blocked` into a workable status, or reassigned a workable issue to
 * another agent. Either way the issue ends assigned to an agent.
 */
export function isHumanUnblock(input: UnblockActor & { before: IssueSide; after: IssueSide }): boolean {
  if (input.requestActorType !== "board" || input.runId) return false;
  const { before, after } = input;
  if (!after.assigneeAgentId || after.assigneeUserId) return false;
  if (!(WORKABLE_STATUSES as readonly string[]).includes(after.status)) return false;
  const leftBlocked = before.status === "blocked";
  const reassigned = before.assigneeAgentId !== after.assigneeAgentId;
  return leftBlocked || reassigned;
}

export interface HumanUnblockResult {
  /** Settled recovery actions whose "blocked" replay disposition was cleared. */
  clearedActionIds: string[];
  /**
   * Agent to wake after commit so its wakes parked on the hold are re-planned,
   * or null when nothing was cleared/parked or another hold still blocks.
   */
  replanAgentId: string | null;
}

/**
 * Clears every settled "do not replay" hold of the issue and reports whether
 * its parked wakes need a re-plan. Must run inside the caller's transaction
 * (`tx`), after the issue row was updated and while it is still locked.
 */
export async function clearReplayHoldsOnHumanUnblock(input: {
  tx: Db;
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  actor: { actorType: "user" | "agent"; actorId: string };
  postCommitActivityPublications?: ActivityPublication[];
}): Promise<HumanUnblockResult> {
  const { tx, companyId, issueId } = input;
  const settled = await tx
    .select()
    .from(issueRecoveryActions)
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
        executionBlockerPredicate(),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
      ),
    )
    .for("update");
  const clearedActionIds: string[] = [];
  for (const action of settled) {
    await clearSettledReplayBlock({
      db: tx,
      companyId,
      action,
      actor: input.actor,
      note: HUMAN_UNBLOCK_NOTE,
      postCommitActivityPublications: input.postCommitActivityPublications,
    });
    clearedActionIds.push(action.id);
  }

  const [parked] = await tx
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, input.assigneeAgentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        sql`jsonb_typeof(${agentWakeupRequests.payload} -> 'executionWait') = 'object'`,
      ),
    )
    .limit(1);
  if (clearedActionIds.length === 0 && !parked) return { clearedActionIds, replanAgentId: null };
  // An active/escalated hold is the vendor's own recovery card and is not
  // lifted here; while one remains, a re-plan wake would only park again.
  const stillBlocked = await getExecutionBlocker(tx, companyId, issueId);
  return { clearedActionIds, replanAgentId: stillBlocked ? null : input.assigneeAgentId };
}

type WakeupFn = (
  agentId: string,
  opts: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    requestedByActorType: "user";
    requestedByActorId: string;
    contextSnapshot: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * After commit: one fresh wake for the assignee, through the ordinary
 * admission. With the hold gone it starts (or coalesces into) a run and adopts
 * the comment wakes parked on the hold. Best effort: the idle-pickup sweep
 * picks the issue up anyway once nothing parks it.
 */
export async function replanParkedWakesAfterUnblock(
  wakeup: WakeupFn,
  input: { issueId: string; agentId: string; actorId: string; clearedActionIds: string[] },
): Promise<void> {
  try {
    await wakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: HUMAN_UNBLOCK_REPLAN_REASON,
      payload: { issueId: input.issueId, mutation: "update", clearedRecoveryActionIds: input.clearedActionIds },
      requestedByActorType: "user",
      requestedByActorId: input.actorId,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: HUMAN_UNBLOCK_REPLAN_REASON,
        source: "issue.unblock",
      },
    });
  } catch (err) {
    logger.warn(
      { err, issueId: input.issueId, agentId: input.agentId },
      "re-plan wake after a board unblock failed; idle pickup retries",
    );
  }
}
