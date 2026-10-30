// myrmidon(L2): clears a settled recovery action's "do not replay"
// disposition so a board operator can un-stick a task through the API
// instead of a raw evidence SQL edit. Called from the vendor's
// POST /issues/:id/recovery-actions/resolve for a closed (resolved/
// cancelled) action targeted by `actionId`; see
// docs/myrmidon/DIVERGENCE.md "L2".
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { issueRecoveryActions, issues, type Db } from "@myrmidon/db";
import { notFound } from "../../errors.js";
import { logActivity, type ActivityPublication } from "../../services/activity-log.js";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";
import { settledReplayHoldWhere } from "./human-unblock.js";

type IssueRecoveryAction = typeof issueRecoveryActions.$inferSelect;

export interface ClearSettledReplayBlockActor {
  actorType: "agent" | "user";
  actorId: string;
}

/**
 * `action` must already be a closed (resolved/cancelled) recovery action
 * whose `evidence.automaticRecovery.replay` reads "blocked"; the caller
 * checks both that and that the actor is a board operator before calling
 * this. This function does not re-check either condition, so a repeat call
 * once `replay` already reads "cleared" only happens if the caller's own
 * guard is bypassed — the caller's guard, not this function, is what makes
 * a repeat `resolve` request a no-op.
 */
export async function clearSettledReplayBlock(input: {
  db: Db;
  companyId: string;
  action: IssueRecoveryAction;
  actor: ClearSettledReplayBlockActor;
  note: string | null;
  /**
   * Same deferred-publication array the caller's other `logActivity` calls
   * in this transaction use (routes/issues.ts's resolve handler); when
   * given, the `activity.logged` live event is queued for the caller to
   * publish once the transaction is known to commit instead of firing
   * immediately from inside it. See services/activity-log.ts's `logActivity`.
   */
  postCommitActivityPublications?: ActivityPublication[];
}): Promise<IssueRecoveryAction> {
  const { db, companyId, action, actor, note, postCommitActivityPublications } = input;
  const automaticRecovery = (action.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
  const clearedAt = new Date();
  const evidence = {
    ...action.evidence,
    automaticRecovery: {
      ...automaticRecovery,
      replay: "cleared",
      replayClearedBy: actor.actorId,
      replayClearedByType: actor.actorType,
      replayClearedAt: clearedAt.toISOString(),
      replayClearedNote: note,
    },
  };
  const [updated] = await db
    .update(issueRecoveryActions)
    .set({ evidence, updatedAt: clearedAt })
    .where(eq(issueRecoveryActions.id, action.id))
    .returning();
  // myrmidon(L2): a 0-row update means `action.id` no longer matches a row
  // (deleted since the caller read it) — never synthesize a cleared record
  // for a write that did not happen. A typed HttpError, not a plain Error,
  // so this rare race surfaces as the route's usual 404 instead of an
  // opaque 500 through error-handler.ts's crash-reporting fallback.
  if (!updated) {
    throw notFound(`Recovery action ${action.id} was not found for update`, {
      recoveryActionId: action.id,
    });
  }
  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "issue.execution_recovery_replay_cleared",
    entityType: "issue",
    entityId: action.sourceIssueId,
    details: {
      recoveryActionId: action.id,
      cause: action.cause,
      recoveryActionStatus: action.status,
      note,
    },
  }, postCommitActivityPublications);
  return updated;
}

/**
 * Clears all settled replay holds for an issue (e.g. after a run of an executor succeeds).
 */
export async function clearSettledReplayHoldsForIssue(
  db: Db,
  companyId: string,
  issueId: string,
  actor: ClearSettledReplayBlockActor,
  note: string,
  postCommitActivityPublications?: ActivityPublication[],
): Promise<string[]> {
  const held = await db
    .select()
    .from(issueRecoveryActions)
    .where(settledReplayHoldWhere(companyId, issueId));
  const clearedActionIds: string[] = [];
  for (const action of held) {
    await clearSettledReplayBlock({
      db,
      companyId,
      action,
      actor,
      note,
      postCommitActivityPublications,
    });
    clearedActionIds.push(action.id);
  }
  return clearedActionIds;
}

/**
 * Clears all settled replay holds for an issue on successful run completion,
 * gated on authoritative current ownership/execution. Stale or unrelated runs
 * for an issue must NOT lift the replay guard.
 */
export async function clearSettledReplayHoldsOnAuthoritativeRunSuccess(
  db: Db,
  run: { id: string; companyId: string; agentId: string; status: string },
  issue: { id: string; assigneeAgentId: string | null; assigneeUserId: string | null; status: string } | null,
  postCommitActivityPublications?: ActivityPublication[],
): Promise<string[] | null> {
  if (run.status !== "succeeded") return null;
  if (!issue) return null;
  if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId !== null) {
    return null;
  }
  if (issue.status === "done" || issue.status === "cancelled") {
    return null;
  }
  return clearSettledReplayHoldsForIssue(
    db,
    run.companyId,
    issue.id,
    { actorType: "agent", actorId: run.agentId },
    `run ${run.id} succeeded`,
    postCommitActivityPublications,
  );
}

/**
 * Periodically clears settled replay holds older than 24 hours on open tasks
 * without side effects (safe class: todo/in_progress without pending interactions,
 * approvals, unblock descriptors or active blockers). One-shot replay protection
 * should not keep workable tasks permanently stuck if nobody manually intervenes.
 */
export async function clearExpiredReplayHolds(db: Db): Promise<number> {
  const rows = await db
    .select({
      action: issueRecoveryActions,
    })
    .from(issueRecoveryActions)
    .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
    .where(
      and(
        inArray(issueRecoveryActions.status, ["resolved", "cancelled"]),
        executionBlockerPredicate(),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        sql`${issueRecoveryActions.createdAt} < now() - interval '24 hours'`,
        // Only safe workable statuses without side effects
        inArray(issues.status, ["todo", "in_progress"]),
        isNull(issues.unblockDescriptor),
        sql`not exists (
          select 1 from issue_thread_interactions iti
          where iti.issue_id = ${issues.id}
            and iti.status = 'pending'
        )`,
        sql`not exists (
          select 1 from issue_approvals ia
          join approvals a on ia.approval_id = a.id
          where ia.issue_id = ${issues.id}
            and a.status in ('pending', 'revision_requested')
        )`,
        sql`not exists (
          select 1 from issue_relations ir
          join issues b on ir.issue_id = b.id
          where ir.related_issue_id = ${issues.id}
            and ir.type = 'blocks'
            and b.status not in ('done', 'cancelled')
        )`,
      ),
    );

  let clearedCount = 0;
  for (const { action } of rows) {
    try {
      await clearSettledReplayBlock({
        db,
        companyId: action.companyId,
        action,
        actor: { actorType: "agent", actorId: "replay_hold_expiration" },
        note: "replay hold expired (>24h old on safe workable issue)",
      });
      clearedCount++;
    } catch {
      // Best effort
    }
  }
  return clearedCount;
}
