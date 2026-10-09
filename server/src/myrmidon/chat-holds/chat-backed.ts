// myrmidon(CHAT-HOLD): a chat is a conversation, not a work ticket.
//
// The owner talks to a bot over a chat bridge (the Telegram DM bridge, and the
// CTO chat that rides on the same standing DM conversation). Each chat is a
// perpetual conversation persisted on a board issue: `chat_conversations`
// binds the bridged thread to that issue, and the vendor's own board chat marks
// its issue with `issues.conversation_agent_id`. Either marker makes the issue
// "chat-backed".
//
// Execution recovery treated such an issue like any work ticket: a crashed or
// cancelled run ended in `blocked` with a settled "do not replay" hold
// (`evidence.automaticRecovery.replay = "blocked"`), and every later owner
// message was parked as `deferred_issue_execution` behind it. The owner only
// saw "Your follow-up is queued" and the bot never answered again. A chat has
// no "replay" to withhold: the next message is a fresh turn the owner asked
// for. See docs/myrmidon/DIVERGENCE.md "CHAT-HOLD".
import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, chatConversations, issues, type Db } from "@paperclipai/db";

/** `evidence.automaticRecovery.policy` of a chat turn recovery settled without a hold. */
export const CHAT_CONTINUATION_POLICY = "chat_continuation_v1";
/**
 * `evidence.automaticRecovery.replay` of that settlement. Anything but
 * "blocked" is not a hold (`executionBlockerPredicate`), so the chat's next
 * message is admitted as a fresh turn.
 */
export const CHAT_CONTINUATION_REPLAY = "chat_continuation";

/**
 * SQL condition over the outer `issues` row: the issue backs a chat — a
 * bridged chat thread (`chat_conversations`) or the vendor's board
 * conversation (`issues.conversation_agent_id`).
 */
export function issueIsChatBacked(): SQL {
  return or(
    isNotNull(issues.conversationAgentId),
    sql`exists (select 1 from ${chatConversations}
      where ${chatConversations.companyId} = ${issues.companyId}
        and ${chatConversations.issueId} = ${issues.id})`,
  )!;
}

/**
 * Whether `issueId` backs a chat. A read failure answers false: the caller
 * then keeps the vendor's ordinary work-ticket recovery, which is the safe
 * side for an issue we cannot classify.
 */
export async function isChatBackedIssue(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId), issueIsChatBacked()))
    .limit(1);
  return Boolean(row);
}

export interface ChatOwnerMessageWakeInput {
  /** The wake carries a durable inbound chat receipt (`opts.durableChatRequest`). */
  durableChatRequest: boolean;
  /** The durable request is the chat's "retry the failed run" button, not a message. */
  failedRunRetry: boolean;
  /** The chat message this wake delivers. */
  commentId: string | null | undefined;
  requestedByActorType: string | null | undefined;
  requestedByActorId: string | null | undefined;
}

/**
 * True when the wake delivers a new message a person wrote in the chat: a
 * durable inbound chat receipt (the bridge authorized the sender against the
 * endpoint, its reach and the linked board user before it ever reached the
 * admission) carrying the message comment, requested by that linked user.
 * A retry of the failed run is the one thing a settled hold withholds and is
 * never this; a chat sender with no linked board user (`system`) is not a
 * person the board can name, so it keeps the vendor admission.
 */
export function isChatOwnerMessageWake(input: ChatOwnerMessageWakeInput): boolean {
  return (
    input.durableChatRequest &&
    !input.failedRunRetry &&
    Boolean(input.commentId) &&
    input.requestedByActorType === "user" &&
    Boolean(input.requestedByActorId)
  );
}

// myrmidon(1.6.5 OWNER-CHAT-ADMISSION): the same person, read from the queue.
//
// The admission gates a start on the host's memory floor and its CPU ceiling —
// both built to pace the AUTOMATIC runs a board wakes by itself. An owner's
// message in a chat is not background work: while the host is merely busy the
// owner's answer queued behind it, and the owner read "the server is loaded,
// your answers are waiting". The queued-run sweep therefore needs to name the
// owner's own turns among the runs it is about to start: those are admitted by
// the server container's own floor (`minFreeMemoryMb`) alone, and rank ahead of
// the automatic runs in the queue. See docs/myrmidon/DIVERGENCE.md
// "OWNER-CHAT-ADMISSION".

/** The idempotency-key prefix of a durable inbound chat receipt (`chat-inbound:<hash>`). */
export const CHAT_INBOUND_WAKE_KEY_PREFIX = "chat-inbound:";

/** The wake-row columns the owner-turn read needs. */
export interface OwnerChatTurnWakeRow {
  idempotencyKey: string | null;
  requestedByActorType: string | null;
  requestedByActorId: string | null;
}

/**
 * True when the wake row delivers a new message a person wrote in the chat: a
 * durable inbound chat receipt (`createDurableChatWakeupRequest`) requested by
 * the linked board user. It is the wake-time person of `isChatOwnerMessageWake`
 * read from the receipt the run points at (`heartbeatRuns.wakeupRequestId`), so
 * the queue and the wake name the same turns.
 */
export function isOwnerChatTurnWake(row: OwnerChatTurnWakeRow): boolean {
  return (
    row.idempotencyKey?.startsWith(CHAT_INBOUND_WAKE_KEY_PREFIX) === true &&
    row.requestedByActorType === "user" &&
    Boolean(row.requestedByActorId)
  );
}

/** The queued run as the owner-turn read needs it. */
export interface OwnerChatTurnCandidateRun {
  id: string;
  wakeupRequestId: string | null;
  /** The run's `contextSnapshot`; a chat retry of a failed run is `chatFailedRunRetry`. */
  contextSnapshot: unknown;
}

/**
 * `contextSnapshot.chatFailedRunRetry`: the run is the chat's own "retry the
 * failed run" button, a re-run of a turn the owner already had — not a new
 * message. `isChatOwnerMessageWake` refuses it at the wake; the queue does not
 * promote it either.
 */
export function isFailedChatRunRetry(contextSnapshot: unknown): boolean {
  return (
    typeof contextSnapshot === "object" &&
    contextSnapshot !== null &&
    Object.hasOwn(contextSnapshot, "chatFailedRunRetry")
  );
}

/**
 * The ids among `runs` that are the owner's own turn in a chat. One query per
 * sweep, keyed by the receipts the runs point at: a run with no receipt, a
 * receipt written for a `system` sender, and the chat's retry button are not
 * the owner's turn, so they keep the vendor's admission and the background
 * rank in the queue.
 *
 * A read failure throws to the caller on purpose: the sweep then keeps the
 * vendor order and the host ceilings, which is the safe side when the turns
 * cannot be told apart.
 */
export async function listOwnerChatTurnRunIds(
  db: Db,
  companyId: string,
  runs: readonly OwnerChatTurnCandidateRun[],
): Promise<Set<string>> {
  const receiptIds = [
    ...new Set(
      runs
        .map((run) => run.wakeupRequestId)
        .filter((receiptId): receiptId is string => Boolean(receiptId)),
    ),
  ];
  if (receiptIds.length === 0) return new Set();
  const receipts = await db
    .select({
      id: agentWakeupRequests.id,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
      requestedByActorType: agentWakeupRequests.requestedByActorType,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, companyId),
        inArray(agentWakeupRequests.id, receiptIds),
      ),
    );
  const ownerReceiptIds = new Set(receipts.filter(isOwnerChatTurnWake).map((receipt) => receipt.id));
  const ownerRunIds = new Set<string>();
  for (const run of runs) {
    if (!run.wakeupRequestId || !ownerReceiptIds.has(run.wakeupRequestId)) continue;
    if (isFailedChatRunRetry(run.contextSnapshot)) continue;
    ownerRunIds.add(run.id);
  }
  return ownerRunIds;
}
