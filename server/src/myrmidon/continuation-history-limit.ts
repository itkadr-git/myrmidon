import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS } from "@paperclipai/shared";
import { issueThreadReference } from "./long-task-context/domain.js";

/**
 * Bounded continuation history (P3 + 1.6.6 LONG-TASK-CONTEXT).
 *
 * buildExecutionContinuation() returns the whole task history. On long tasks the
 * rendered wake prompt outgrows the per-argument limit of the OS and the agent
 * process fails to start (spawn E2BIG). This module caps every unbounded list of
 * the envelope to the newest N entries. Ownership, integrity and authorization
 * checks keep running against the full history upstream; only the returned
 * envelope is trimmed.
 *
 * Messages that carry direction are always kept, even when older than the newest
 * N: the original request of the task, the latest request, and the comments the
 * run was woken for (originCommentIds).
 *
 * 1.6.6 adds the VOLUME bound an ever-running task needs: the newest N entries
 * of a 165-comment thread can still be hundreds of kilobytes, and the whole
 * point of the long-task context guard is that this payload must not grow with
 * the age of the task. Two caps apply on top of the count:
 *
 *   - a total budget of message text (`historyChars`, default 24k) — the
 *     newest entries are taken until the budget is spent, older ones are
 *     dropped and referenced through the issue API instead of travelling with
 *     every run;
 *   - a per-entry cap (`messageMaxChars`, default 8k) — one paste-sized
 *     comment can eat the whole budget, so a single oversized body is cut with
 *     an explicit marker naming where its full text stays.
 *
 * Both are env-tunable for an incident (`MYRMIDON_CONTINUATION_HISTORY_CHARS`,
 * `MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS`); 0 disables the respective cap.
 */

export const CONTINUATION_HISTORY_LIMIT_ENV = "MYRMIDON_CONTINUATION_HISTORY_LIMIT";
export const DEFAULT_CONTINUATION_HISTORY_LIMIT = 30;

/** Volume budget of the message text in one envelope; the shared long-task default. */
export const CONTINUATION_HISTORY_CHARS_ENV = "MYRMIDON_CONTINUATION_HISTORY_CHARS";
export const DEFAULT_CONTINUATION_HISTORY_CHARS = LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS;

/** Cap of a single entry's body; one oversized comment must not eat the budget. */
export const CONTINUATION_MESSAGE_MAX_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_MAX_CHARS = 8_000;

type Message = ExecutionContinuationEnvelope["messages"][number];

export interface ContinuationListTruncation {
  kept: number;
  dropped: number;
  total: number;
}

export type ContinuationHistoryTruncation = Partial<
  Record<
    | "messages"
    | "resumeDeltaMessages"
    | "messageBodies"
    | "interactionOutcomes"
    | "completedActions"
    | "recoveryOutcomes"
    | "unresolvedInteractionIds",
    ContinuationListTruncation
  >
>;

export type LimitedExecutionContinuationEnvelope = ExecutionContinuationEnvelope & {
  historyTruncation?: ContinuationHistoryTruncation;
  truncationNotice?: string;
};

/** Returns the configured limit; 0 disables the limit. Invalid values fall back to the default. */
export function readContinuationHistoryLimit(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(env[CONTINUATION_HISTORY_LIMIT_ENV], DEFAULT_CONTINUATION_HISTORY_LIMIT);
}

/** Returns the configured volume budget in characters; 0 disables the cap. */
export function readContinuationHistoryChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(env[CONTINUATION_HISTORY_CHARS_ENV], DEFAULT_CONTINUATION_HISTORY_CHARS);
}

/** Returns the configured per-entry cap in characters; 0 disables the cap. */
export function readContinuationMessageMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(
    env[CONTINUATION_MESSAGE_MAX_CHARS_ENV],
    DEFAULT_CONTINUATION_MESSAGE_MAX_CHARS,
  );
}

function readNonNegativeInt(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function isUserRequest(message: Message): boolean {
  return (
    message.authorType === "user" &&
    !message.createdByRunId &&
    !message.deleted &&
    message.body.trim().length > 0
  );
}

/** Ids of the messages that must survive truncation, computed on the full history. */
function pinnedMessageIds(messages: Message[], originCommentIds: string[]): Set<string> {
  const pinned = new Set<string>(originCommentIds);
  const first = messages.find(isUserRequest);
  const latest = messages.findLast(isUserRequest);
  if (first) pinned.add(first.id);
  if (latest) pinned.add(latest.id);
  return pinned;
}

/** Keeps pinned messages plus the newest ones, up to `limit` in total when the pins allow it. */
function limitMessages(
  messages: Message[],
  pinned: Set<string>,
  limit: number,
): { items: Message[]; truncation: ContinuationListTruncation | null } {
  if (messages.length <= limit) return { items: messages, truncation: null };
  const keep = new Set<string>();
  for (const message of messages) if (pinned.has(message.id)) keep.add(message.id);
  for (let i = messages.length - 1; i >= 0 && keep.size < limit; i -= 1) keep.add(messages[i]!.id);
  const items = messages.filter((message) => keep.has(message.id));
  return {
    items,
    truncation: { kept: items.length, dropped: messages.length - items.length, total: messages.length },
  };
}

/**
 * Keeps the newest messages that fit the character budget. Pinned messages are
 * always kept — direction never disappears, even when it is what blows the
 * budget.
 */
function limitMessagesByVolume(
  messages: Message[],
  pinned: Set<string>,
  chars: number,
): { items: Message[]; truncation: ContinuationListTruncation | null } {
  if (chars <= 0) return { items: messages, truncation: null };
  const keep = new Set<string>();
  let budget = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const size = message.body.length;
    if (pinned.has(message.id) || budget + size <= chars) {
      keep.add(message.id);
      budget += size;
    }
  }
  if (keep.size === messages.length) return { items: messages, truncation: null };
  const items = messages.filter((message) => keep.has(message.id));
  return {
    items,
    truncation: { kept: items.length, dropped: messages.length - items.length, total: messages.length },
  };
}

/** Cuts the body of any entry longer than the per-entry cap, marking where the rest stays. */
function capMessageBodies(
  messages: Message[],
  maxChars: number,
  issueId: string | null,
): { items: Message[]; cappedIds: string[] } {
  if (maxChars <= 0) return { items: messages, cappedIds: [] };
  const cappedIds: string[] = [];
  const items = messages.map((message) => {
    if (message.body.length <= maxChars) return message;
    cappedIds.push(message.id);
    const omitted = message.body.length - maxChars;
    return {
      ...message,
      body:
        `${message.body.slice(0, maxChars)}\n\n[myrmidon: ${omitted} characters of this entry were omitted ` +
        `from the launch payload; the full text stays in the task thread: ${issueThreadReference(issueId)}]`,
    };
  });
  return { items, cappedIds };
}

/** Keeps the newest `limit` entries of a list sorted oldest first. */
function limitList<T>(
  list: T[] | undefined,
  limit: number,
): { items: T[] | undefined; truncation: ContinuationListTruncation | null } {
  if (!list || list.length <= limit) return { items: list, truncation: null };
  const items = list.slice(-limit);
  return { items, truncation: { kept: items.length, dropped: list.length - items.length, total: list.length } };
}

/** The count-and-volume pipeline of one message list, reported against its original length. */
function boundMessages(
  messages: Message[],
  pinned: Set<string>,
  options: { limit: number; chars: number; messageMaxChars: number; issueId: string | null },
): { items: Message[]; truncated: boolean; cappedIds: string[] } {
  const byCount = limitMessages(messages, pinned, options.limit);
  const byVolume = limitMessagesByVolume(byCount.items, pinned, options.chars);
  const bodies = capMessageBodies(byVolume.items, options.messageMaxChars, options.issueId);
  return {
    items: bodies.items,
    truncated: byCount.items.length !== messages.length || byVolume.items.length !== byCount.items.length,
    cappedIds: bodies.cappedIds,
  };
}

export function limitExecutionContinuationHistory(
  envelope: ExecutionContinuationEnvelope,
  limit: number = readContinuationHistoryLimit(),
  chars: number = readContinuationHistoryChars(),
  messageMaxChars: number = readContinuationMessageMaxChars(),
): LimitedExecutionContinuationEnvelope {
  if (limit <= 0 && chars <= 0 && messageMaxChars <= 0) return envelope;

  const issueId = envelope.issueId ?? null;
  const pinned = pinnedMessageIds(envelope.messages, envelope.originCommentIds);
  const messages = boundMessages(envelope.messages, pinned, {
    limit: limit > 0 ? limit : Number.MAX_SAFE_INTEGER,
    chars,
    messageMaxChars,
    issueId,
  });
  const resumeDeltaMessages = envelope.resumeDelta
    ? boundMessages(envelope.resumeDelta.messages, pinned, {
        limit: limit > 0 ? limit : Number.MAX_SAFE_INTEGER,
        chars,
        messageMaxChars,
        issueId,
      })
    : null;
  const interactionOutcomes = limitList(envelope.interactionOutcomes, limit);
  const completedActions = limitList(envelope.completedActions, limit);
  const recoveryOutcomes = limitList(envelope.recoveryOutcomes, limit);
  const unresolvedInteractionIds = limitList(envelope.unresolvedInteractionIds, limit);

  const truncation: ContinuationHistoryTruncation = {};
  if (messages.truncated) {
    truncation.messages = {
      kept: messages.items.length,
      dropped: envelope.messages.length - messages.items.length,
      total: envelope.messages.length,
    };
  }
  if (messages.cappedIds.length > 0) {
    truncation.messageBodies = {
      kept: messages.items.length,
      dropped: messages.cappedIds.length,
      total: messages.items.length,
    };
  }
  if (resumeDeltaMessages?.truncated) {
    truncation.resumeDeltaMessages = {
      kept: resumeDeltaMessages.items.length,
      dropped: envelope.resumeDelta!.messages.length - resumeDeltaMessages.items.length,
      total: envelope.resumeDelta!.messages.length,
    };
  }
  if (interactionOutcomes.truncation) truncation.interactionOutcomes = interactionOutcomes.truncation;
  if (completedActions.truncation) truncation.completedActions = completedActions.truncation;
  if (recoveryOutcomes.truncation) truncation.recoveryOutcomes = recoveryOutcomes.truncation;
  if (unresolvedInteractionIds.truncation) {
    truncation.unresolvedInteractionIds = unresolvedInteractionIds.truncation;
  }
  const entries = Object.entries(truncation) as Array<[string, ContinuationListTruncation]>;
  if (entries.length === 0) return envelope;

  const bounds: string[] = [];
  if (limit > 0) bounds.push(`the newest ${limit} entries per list`);
  if (chars > 0) bounds.push(`${chars} characters of message text`);
  const boundText = bounds.length > 0 ? bounds.join(" and ") : "the newest entries";
  const result: LimitedExecutionContinuationEnvelope = {
    ...envelope,
    messages: messages.items,
    interactionOutcomes: interactionOutcomes.items ?? [],
    unresolvedInteractionIds: unresolvedInteractionIds.items ?? [],
    historyTruncation: truncation,
    truncationNotice:
      `Task history was shortened to ${boundText} to keep the launch payload within process limits (long ` +
      "tasks must not grow the payload with their age). The original request, the latest request and the " +
      "comments that triggered this run are always included. Omitted entries: " +
      entries.map(([name, value]) => `${name} ${value.dropped} of ${value.total}`).join(", ") +
      `. Read the task thread through the API if you need the older entries: ${issueThreadReference(issueId)}.`,
  };
  if (envelope.resumeDelta && resumeDeltaMessages) {
    result.resumeDelta = { ...envelope.resumeDelta, messages: resumeDeltaMessages.items };
  }
  if (completedActions.items) result.completedActions = completedActions.items;
  if (recoveryOutcomes.items) result.recoveryOutcomes = recoveryOutcomes.items;
  return result;
}