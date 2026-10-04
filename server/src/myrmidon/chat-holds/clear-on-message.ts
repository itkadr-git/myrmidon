// myrmidon(CHAT-HOLD): an owner message in a chat lifts the chat's settled
// "do not replay" hold, atomically with the successor run the wake admission is
// about to create.
//
// The same shape as the board unblock of HOLD-READY (settled-holds/
// human-unblock.ts) and the explicit-wake supersede of L2 (settled-holds/
// supersede-explicit-wake.ts): only a closed (resolved/cancelled) hold whose
// named run has verifiably released its execution claim is lifted
// (`explicitWakeBypassesSettledHold`); a recovery that is still working
// (`active`/`escalated`) or a run that still owns a process or lease keeps
// blocking. The lift is recorded on the action and in the activity log, and a
// chat the recovery itself moved to `blocked` is returned to `todo` — the chat
// is a conversation the owner just continued, not a ticket waiting on a human.
// See chat-backed.ts and docs/myrmidon/DIVERGENCE.md "CHAT-HOLD".
import { and, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { persistActivity } from "../../services/activity-log.js";
import { executionBlockerPredicate } from "../../services/execution-blocker.js";
import { explicitWakeBypassesSettledHold } from "../settled-holds/explicit-wake-bypass.js";

export const CHAT_OWNER_MESSAGE_CONTINUATION = "chat_owner_message";

export interface ClearChatHoldsOnOwnerMessageInput {
  /** The admission's transaction; the issue row is already locked by it. */
  db: Db;
  companyId: string;
  issueId: string;
  /** The issue status the admission read under its lock. */
  issueStatus: string;
  /** The run id the admission reserved for the successor it is about to insert. */
  successorRunId: string;
  /** The linked board user who wrote the message. */
  requestedByActorId: string;
  /** The chat message comment the wake delivers. */
  commentId: string;
}

export interface ClearChatHoldsOnOwnerMessageResult {
  recoveryActionIds: string[];
  /** True when the chat was moved from `blocked` back to `todo`. */
  statusRestored: boolean;
}

/**
 * Lifts every settled hold of the chat issue that is safe to lift. A no-op
 * (returns null) when there is none. Persists the activity row without a live
 * event: this runs inside the caller's still-uncommitted admission
 * transaction, the same as the vendor's explicit continuation.
 */
export async function clearChatHoldsOnOwnerMessage(
  input: ClearChatHoldsOnOwnerMessageInput,
): Promise<ClearChatHoldsOnOwnerMessageResult | null> {
  const { db, companyId, issueId, successorRunId, requestedByActorId, commentId } = input;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return null;

  const recordedAt = new Date();
  const clearedIds: string[] = [];
  let recoveryBlockedTheChat = false;
  for (const action of actions) {
    if (!(await explicitWakeBypassesSettledHold(db, companyId, action))) continue;
    const automaticRecovery = (action.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
    const [updated] = await db.update(issueRecoveryActions).set({
      status: "resolved",
      outcome: "handed_back",
      resolvedAt: recordedAt,
      updatedAt: recordedAt,
      nextAction: "The owner continued the chat. A fresh turn answers the new message; nothing was replayed.",
      resolutionNote: "A new chat message is a fresh turn, not a replay of the stopped run. Prior action outcomes remain recorded.",
      wakePolicy: null,
      monitorPolicy: null,
      evidence: {
        ...action.evidence,
        chatOwnerMessage: { successorRunId, requestedByActorId, commentId, recordedAt: recordedAt.toISOString() },
        automaticRecovery: {
          ...automaticRecovery,
          replay: CHAT_OWNER_MESSAGE_CONTINUATION,
          successorRunId,
          replayClearedBy: requestedByActorId,
          replayClearedByType: "user",
          replayClearedAt: recordedAt.toISOString(),
        },
      },
    }).where(and(eq(issueRecoveryActions.id, action.id), eq(issueRecoveryActions.companyId, companyId)))
      .returning({ id: issueRecoveryActions.id });
    if (!updated) continue;
    clearedIds.push(updated.id);
    if (action.outcome === "blocked") recoveryBlockedTheChat = true;
  }
  if (!clearedIds.length) return null;

  let statusRestored = false;
  if (recoveryBlockedTheChat && input.issueStatus === "blocked") {
    const restored = await db.update(issues)
      .set({ status: "todo", statusVersion: sql`${issues.statusVersion} + 1` as unknown as number, updatedAt: recordedAt })
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), eq(issues.status, "blocked")))
      .returning({ id: issues.id });
    statusRestored = restored.length > 0;
  }

  await persistActivity(db, {
    companyId,
    actorType: "user",
    actorId: requestedByActorId,
    action: "issue.execution_recovery_settled",
    entityType: "issue",
    entityId: issueId,
    details: {
      continuation: CHAT_OWNER_MESSAGE_CONTINUATION,
      successorRunId,
      commentId,
      recoveryActionIds: clearedIds,
      ...(statusRestored ? { statusRestored: { from: "blocked", to: "todo" } } : {}),
    },
  });
  return { recoveryActionIds: clearedIds, statusRestored };
}
