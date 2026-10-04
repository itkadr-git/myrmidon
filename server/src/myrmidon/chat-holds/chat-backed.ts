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
import { and, eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { chatConversations, issues, type Db } from "@paperclipai/db";

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
