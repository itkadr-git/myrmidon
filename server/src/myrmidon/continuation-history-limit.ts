import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";

/**
 * Bounded continuation history (P3 + DB-CARE DBC-3).
 *
 * buildExecutionContinuation() returns the whole task history. On long tasks the
 * rendered wake prompt outgrows the per-argument limit of the OS and the agent
 * process fails to start (spawn E2BIG). This module caps every unbounded list of
 * the envelope to the newest N entries; the message list is additionally capped
 * by characters. Ownership, integrity and authorization checks keep running
 * against the full history upstream; only the returned envelope is trimmed.
 *
 * Messages that carry direction are always kept, even when older than the newest
 * N: the original request of the task, the latest request, and the comments the
 * run was woken for (originCommentIds).
 *
 * DB-CARE DBC-3 added the character budget: an entry count alone does not bound
 * the payload when a task has few but very long comments (long tool dumps pasted
 * into one comment). Messages over the budget keep their identity and freshness
 * and hand the body back as a reference (`bodyOmitted`), so the resume delta
 * keeps comparing like with like; the body itself stays in the task thread.
 */

export const CONTINUATION_HISTORY_LIMIT_ENV = "MYRMIDON_CONTINUATION_HISTORY_LIMIT";
export const DEFAULT_CONTINUATION_HISTORY_LIMIT = 30;

/** myrmidon(DB-CARE DBC-3): character budget of `messages`; 0 disables the budget. */
export const CONTINUATION_MESSAGE_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_CHARS = 32_000;

/** myrmidon(DB-CARE DBC-3): per-body budget used once the total budget is exceeded. */
export const CONTINUATION_MESSAGE_BODY_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_BODY_CHARS = 8_000;

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
    | "interactionOutcomes"
    | "completedActions"
    | "recoveryOutcomes"
    | "unresolvedInteractionIds",
    ContinuationListTruncation
  >
>;

/** Size accounting of the character budget applied to `messages`. */
export interface ContinuationCharTruncation {
  budgetChars: number;
  beforeChars: number;
  afterChars: number;
  /** Bodies replaced by a reference (`bodyOmitted`) to fit the budget. */
  bodiesReplaced: number;
  /** Bodies shortened to the per-body budget. */
  bodiesTruncated: number;
  /** Messages dropped after their bodies had already become references. */
  messagesDropped: number;
}

export type LimitedExecutionContinuationEnvelope = ExecutionContinuationEnvelope & {
  historyTruncation?: ContinuationHistoryTruncation;
  historyCharTruncation?: ContinuationCharTruncation;
  truncationNotice?: string;
};

function readNonNegativeLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

/** Returns the configured limit; 0 disables the caps. Invalid values fall back to the default. */
export function readContinuationHistoryLimit(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeLimit(env, CONTINUATION_HISTORY_LIMIT_ENV, DEFAULT_CONTINUATION_HISTORY_LIMIT);
}

/** myrmidon(DB-CARE DBC-3): character budget of the message list; 0 disables the budget. */
export function readContinuationMessageChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeLimit(env, CONTINUATION_MESSAGE_CHARS_ENV, DEFAULT_CONTINUATION_MESSAGE_CHARS);
}

/** myrmidon(DB-CARE DBC-3): per-body budget applied once the total budget is exceeded. */
export function readContinuationMessageBodyChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeLimit(
    env,
    CONTINUATION_MESSAGE_BODY_CHARS_ENV,
    DEFAULT_CONTINUATION_MESSAGE_BODY_CHARS,
  );
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

/** Serialized size of one message: the budget is measured on what gets stored. */
function messageChars(message: Message): number {
  return JSON.stringify(message).length;
}

function messagesChars(messages: Message[]): number {
  let total = 0;
  for (const message of messages) total += messageChars(message);
  return total;
}

/**
 * Deterministic body cut, so a message capped in one run compares equal to the
 * same message capped in the next one and never re-enters the resume delta.
 */
function truncateBody(body: string, budget: number): string {
  const omitted = body.length - budget;
  return `${body.slice(0, budget)}\n\n[continuation cap: ${omitted} of ${body.length} characters omitted; read the full comment through the API]`;
}

/** Reference-only form: identity and freshness stay, the body goes away. */
function asReference(message: Message): Message {
  return { ...message, body: "", bodyOmitted: true };
}

interface CharCapResult {
  items: Message[];
  /** Capped form of every message whose body changed, keyed by message id. */
  replacements: Map<string, Message>;
  stats: ContinuationCharTruncation | null;
}

/**
 * Fits the message list into a character budget without losing direction:
 * the oldest non-pinned bodies become references first, then those referenced
 * messages are dropped, and only then are the remaining bodies shortened to
 * `bodyBudget` each.
 */
function capMessagesByChars(
  messages: Message[],
  pinned: Set<string>,
  budgetChars: number,
  bodyBudget: number,
): CharCapResult {
  const beforeChars = messagesChars(messages);
  if (budgetChars <= 0 || beforeChars <= budgetChars) {
    return { items: messages, replacements: new Map(), stats: null };
  }

  const items = [...messages];
  let chars = beforeChars;
  const replacements = new Map<string, Message>();
  let bodiesReplaced = 0;
  let bodiesTruncated = 0;
  let messagesDropped = 0;

  const replace = (index: number, replacement: Message) => {
    const previous = items[index]!;
    chars += messageChars(replacement) - messageChars(previous);
    items[index] = replacement;
    replacements.set(replacement.id, replacement);
  };

  // 1. Oldest non-pinned bodies become references.
  for (let index = 0; index < items.length && chars > budgetChars; index += 1) {
    const message = items[index]!;
    if (pinned.has(message.id) || message.bodyOmitted || message.body.length === 0) continue;
    replace(index, asReference(message));
    bodiesReplaced += 1;
  }

  // 2. Still over budget: drop the oldest referenced messages, they carry no direction.
  if (chars > budgetChars) {
    const kept: Message[] = [];
    for (const message of items) {
      if (chars > budgetChars && !pinned.has(message.id) && replacements.has(message.id)) {
        chars -= messageChars(message);
        messagesDropped += 1;
        continue;
      }
      kept.push(message);
    }
    items.length = 0;
    items.push(...kept);
  }

  // 3. Still over budget: what is left is pinned or oversized, shorten those bodies.
  for (let index = 0; index < items.length && chars > budgetChars; index += 1) {
    const message = items[index]!;
    if (message.body.length <= bodyBudget) continue;
    replace(index, { ...message, body: truncateBody(message.body, bodyBudget) });
    bodiesTruncated += 1;
  }

  return {
    items,
    replacements,
    stats: {
      budgetChars,
      beforeChars,
      afterChars: chars,
      bodiesReplaced,
      bodiesTruncated,
      messagesDropped,
    },
  };
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

/** Keeps the newest `limit` entries of a list sorted oldest first. */
function limitList<T>(
  list: T[] | undefined,
  limit: number,
): { items: T[] | undefined; truncation: ContinuationListTruncation | null } {
  if (!list || list.length <= limit) return { items: list, truncation: null };
  const items = list.slice(-limit);
  return { items, truncation: { kept: items.length, dropped: list.length - items.length, total: list.length } };
}

export function limitExecutionContinuationHistory(
  envelope: ExecutionContinuationEnvelope,
  limit: number = readContinuationHistoryLimit(),
  messageChars: number = readContinuationMessageChars(),
  messageBodyChars: number = readContinuationMessageBodyChars(),
): LimitedExecutionContinuationEnvelope {
  // 0 disables the bounded history, character budget included; set
  // MYRMIDON_CONTINUATION_MESSAGE_CHARS=0 to keep the entry cap only.
  if (limit <= 0) return envelope;

  const pinned = pinnedMessageIds(envelope.messages, envelope.originCommentIds);
  const messages = limitMessages(envelope.messages, pinned, limit);
  const resumeDeltaMessages = envelope.resumeDelta
    ? limitMessages(envelope.resumeDelta.messages, pinned, limit)
    : null;
  // myrmidon(DB-CARE DBC-3): the character budget runs after the entry cap and
  // covers the delta as well, so a resumed wake cannot pour the bodies back in.
  const capped = capMessagesByChars(messages.items, pinned, messageChars, messageBodyChars);
  const cappedDelta = (resumeDeltaMessages?.items ?? []).map(
    (message) => capped.replacements.get(message.id) ?? message,
  );
  const interactionOutcomes = limitList(envelope.interactionOutcomes, limit);
  const completedActions = limitList(envelope.completedActions, limit);
  const recoveryOutcomes = limitList(envelope.recoveryOutcomes, limit);
  const unresolvedInteractionIds = limitList(envelope.unresolvedInteractionIds, limit);

  const truncation: ContinuationHistoryTruncation = {};
  if (messages.truncation) truncation.messages = messages.truncation;
  if (resumeDeltaMessages?.truncation) truncation.resumeDeltaMessages = resumeDeltaMessages.truncation;
  if (interactionOutcomes.truncation) truncation.interactionOutcomes = interactionOutcomes.truncation;
  if (completedActions.truncation) truncation.completedActions = completedActions.truncation;
  if (recoveryOutcomes.truncation) truncation.recoveryOutcomes = recoveryOutcomes.truncation;
  if (unresolvedInteractionIds.truncation) {
    truncation.unresolvedInteractionIds = unresolvedInteractionIds.truncation;
  }
  const entries = Object.entries(truncation) as Array<[string, ContinuationListTruncation]>;
  if (entries.length === 0 && !capped.stats) return envelope;

  const notices: string[] = [];
  if (entries.length > 0) {
    notices.push(
      `Task history was shortened to the newest ${limit} entries per list to keep the launch ` +
        "payload within process limits. The original request, the latest request and the " +
        "comments that triggered this run are always included. Omitted entries: " +
        entries.map(([name, value]) => `${name} ${value.dropped} of ${value.total}`).join(", ") +
        ". Read the task thread through the API if you need the older entries.",
    );
  }
  if (capped.stats) {
    notices.push(
      `Message bodies exceeded the ${capped.stats.budgetChars}-character continuation budget ` +
        `(${capped.stats.beforeChars} before, ${capped.stats.afterChars} after): ` +
        `${capped.stats.bodiesReplaced} older bodies became references, ` +
        `${capped.stats.bodiesTruncated} bodies were shortened to ${messageBodyChars} characters and ` +
        `${capped.stats.messagesDropped} referenced messages were dropped. Bodies stay in the task ` +
        "thread and remain readable through the API.",
    );
  }

  const result: LimitedExecutionContinuationEnvelope = {
    ...envelope,
    messages: capped.items,
    interactionOutcomes: interactionOutcomes.items ?? [],
    unresolvedInteractionIds: unresolvedInteractionIds.items ?? [],
    historyTruncation: truncation,
    truncationNotice: notices.join(" "),
  };
  if (capped.stats) result.historyCharTruncation = capped.stats;
  if (envelope.resumeDelta && resumeDeltaMessages) {
    result.resumeDelta = { ...envelope.resumeDelta, messages: cappedDelta };
  }
  if (completedActions.items) result.completedActions = completedActions.items;
  if (recoveryOutcomes.items) result.recoveryOutcomes = recoveryOutcomes.items;
  return result;
}