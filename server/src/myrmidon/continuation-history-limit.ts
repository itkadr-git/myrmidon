import type { ExecutionContinuationEnvelope } from "@myrmidon/shared";
import { LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS } from "@myrmidon/shared";
import { issueThreadReference } from "./long-task-context/domain.js";

/**
 * Bounded continuation history (P3 + 1.6.6 LONG-TASK-CONTEXT + DB-CARE DBC-3 +
 * OPE-2321 byte ceiling).
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
 *
 * OPE-2321 adds the BYTE ceiling on the whole serialized envelope: the
 * character budgets above are measured in UTF-16 code units, but the kernel
 * counts UTF-8 bytes when a spawn argument or environment string carries this
 * envelope (MAX_ARG_STRLEN = 131072). Cyrillic and other non-ASCII text costs
 * two to four bytes per character, so a history inside the character budget
 * can still cross the byte limit. The byte pass is measured on
 * `JSON.stringify` of the envelope, targets 96 KiB by default (comfortably
 * under the 128 KiB per-string kernel limit with room for the wrapper JSON),
 * and trims the message list with the same reference → drop → shorten order
 * and the same pinned-direction guarantees as the character pass.
 *
 * DB-CARE DBC-3 added the character budget: an entry count alone does not bound
 * the payload when a task has few but very long comments (long tool dumps pasted
 * into one comment). Messages over the budget keep their identity and freshness
 * and hand the body back as a reference (`bodyOmitted`), so the resume delta
 * keeps comparing like with like; the body itself stays in the task thread.
 */

export const CONTINUATION_HISTORY_LIMIT_ENV = "MYRMIDON_CONTINUATION_HISTORY_LIMIT";
export const DEFAULT_CONTINUATION_HISTORY_LIMIT = 30;

/** Volume budget of the message text in one envelope; the shared long-task default. */
export const CONTINUATION_HISTORY_CHARS_ENV = "MYRMIDON_CONTINUATION_HISTORY_CHARS";
export const DEFAULT_CONTINUATION_HISTORY_CHARS = LONG_TASK_CONTEXT_DEFAULT_HISTORY_CHARS;

/** Cap of a single entry's body; one oversized comment must not eat the budget. */
export const CONTINUATION_MESSAGE_MAX_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_MAX_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_MAX_CHARS = 8_000;
/** myrmidon(DB-CARE DBC-3): character budget of `messages`; 0 disables the budget. */
export const CONTINUATION_MESSAGE_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_CHARS = 32_000;

/** myrmidon(DB-CARE DBC-3): per-body budget used once the total budget is exceeded. */
export const CONTINUATION_MESSAGE_BODY_CHARS_ENV = "MYRMIDON_CONTINUATION_MESSAGE_BODY_CHARS";
export const DEFAULT_CONTINUATION_MESSAGE_BODY_CHARS = 8_000;

/**
 * myrmidon(OPE-2321): byte ceiling of the serialized envelope. The kernel's
 * MAX_ARG_STRLEN (131072) counts UTF-8 bytes of one argv/env string; the
 * character budgets above count UTF-16 code units, so non-ASCII history can
 * pass them and still fail spawn. 96 KiB leaves room for the wrapper JSON the
 * serialized envelope travels in.
 */
export const CONTINUATION_ENVELOPE_BYTES_ENV = "MYRMIDON_CONTINUATION_ENVELOPE_BYTES";
export const DEFAULT_CONTINUATION_ENVELOPE_BYTES = 96 * 1024;

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
  /** myrmidon(OPE-2321): set when the byte ceiling changed the envelope. */
  messagesTruncated?: ContinuationByteTruncation;
  truncationNotice?: string;
};

/** Size accounting of the OPE-2321 byte ceiling applied to the serialized envelope. */
export interface ContinuationByteTruncation {
  budgetBytes: number;
  beforeBytes: number;
  afterBytes: number;
  /** Bodies replaced by a reference (`bodyOmitted`) by the byte pass. */
  bodiesReplaced: number;
  /** Bodies shortened by the byte pass. */
  bodiesTruncated: number;
  /** Messages dropped (reference-form first) by the byte pass. */
  messagesDropped: number;
  /** True when the pinned-direction messages alone are near the ceiling. */
  pinnedOverBudget: boolean;
}

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

/** myrmidon(DB-CARE DBC-3): character budget of `messages`; 0 disables the budget. */
export function readContinuationMessageChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(env[CONTINUATION_MESSAGE_CHARS_ENV], DEFAULT_CONTINUATION_MESSAGE_CHARS);
}

/** myrmidon(OPE-2321): byte ceiling of the serialized envelope; 0 disables it. */
export function readContinuationEnvelopeBytes(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(env[CONTINUATION_ENVELOPE_BYTES_ENV], DEFAULT_CONTINUATION_ENVELOPE_BYTES);
}

/** myrmidon(DB-CARE DBC-3): per-body budget applied once the total budget is exceeded. */
export function readContinuationMessageBodyChars(env: NodeJS.ProcessEnv = process.env): number {
  return readNonNegativeInt(
    env[CONTINUATION_MESSAGE_BODY_CHARS_ENV],
    DEFAULT_CONTINUATION_MESSAGE_BODY_CHARS,
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

function capMessagesBySerializedBytes(
  envelope: LimitedExecutionContinuationEnvelope,
  pinned: Set<string>,
  budgetBytes: number,
  bodyBudget: number,
): { envelope: LimitedExecutionContinuationEnvelope; stats: ContinuationByteTruncation | null } {
  const beforeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
  if (budgetBytes <= 0) {
    return { envelope, stats: null };
  }
  // The stats object and the appended notice serialize into the same envelope
  // and the same argv/env string, so the pass aims below the ceiling and keeps
  // headroom for its own annotations (plus JSON escaping jitter).
  const reserve = Math.min(1024, Math.floor(budgetBytes / 2));
  const effectiveBudget = budgetBytes - reserve;
  if (beforeBytes <= effectiveBudget) {
    return { envelope, stats: null };
  }

  // The envelope carries the history twice on a resume: `messages` and
  // `resumeDelta.messages`. Byte decisions are made once per unique message and
  // applied to both lists, so neither copy can pour the trimmed text back in.
  const mainById = new Map(envelope.messages.map((message) => [message.id, message]));
  const unique: Message[] = [...envelope.messages];
  for (const message of envelope.resumeDelta?.messages ?? []) {
    if (!mainById.has(message.id)) unique.push(message);
  }
  const replaced = new Map<string, Message>();
  const dropped = new Set<string>();
  const shortened = new Map<string, Message>();

  const rebuild = (): LimitedExecutionContinuationEnvelope => {
    const applyOne = (message: Message): Message | null => {
      if (dropped.has(message.id)) return null;
      return shortened.get(message.id) ?? replaced.get(message.id) ?? message;
    };
    const next: LimitedExecutionContinuationEnvelope = {
      ...envelope,
      messages: envelope.messages.map(applyOne).filter((message): message is Message => message !== null),
    };
    if (envelope.resumeDelta) {
      next.resumeDelta = {
        ...envelope.resumeDelta,
        messages: envelope.resumeDelta.messages
          .map(applyOne)
          .filter((message): message is Message => message !== null),
      };
    }
    return next;
  };

  let current = envelope;
  let bytes = beforeBytes;
  const apply = (next: LimitedExecutionContinuationEnvelope) => {
    current = next;
    bytes = Buffer.byteLength(JSON.stringify(current), "utf8");
  };

  // 1. Oldest non-pinned bodies become references; identity stays comparable.
  for (const message of unique) {
    if (bytes <= effectiveBudget) break;
    if (pinned.has(message.id) || replaced.has(message.id) || message.bodyOmitted || message.body.length === 0) {
      continue;
    }
    replaced.set(message.id, asReference(message));
    apply(rebuild());
  }

  // 2. Drop the oldest referenced messages next; they carry no direction.
  for (const message of unique) {
    if (bytes <= effectiveBudget) break;
    if (!replaced.has(message.id) || pinned.has(message.id) || dropped.has(message.id)) continue;
    dropped.add(message.id);
    apply(rebuild());
  }

  const remaining = () =>
    unique
      .filter((message) => !dropped.has(message.id))
      .map((message) => ({
        message,
        size: Buffer.byteLength(message.body, "utf8"),
        stub: shortened.get(message.id) ?? replaced.get(message.id) ?? message,
      }))
      .sort((a, b) => {
        const aPin = pinned.has(a.message.id) ? 1 : 0;
        const bPin = pinned.has(b.message.id) ? 1 : 0;
        if (aPin !== bPin) return aPin - bPin;
        return b.size - a.size;
      });

  const shortenLargest = (forced: boolean): boolean => {
    for (const { message, size, stub } of remaining()) {
      if (shortened.has(message.id)) continue;
      const stubBody = stub.body;
      // The character budget decides how large a stub may stay; when it is
      // disabled (0) fall back to a 1-character stub so the pass still
      // converges instead of looping on a body that refuses to shrink.
      let target = bodyBudget > 0 ? Math.min(stubBody.length, bodyBudget) : Math.min(stubBody.length, 1);
      if (forced && size - Buffer.byteLength(stubBody.slice(0, target), "utf8") <= 0) {
        // Nothing above the character budget is left to shorten; halve what
        // remains so the pass still converges when the pinned direction
        // alone sits above the byte ceiling.
        target = Math.max(1, Math.floor(stubBody.length / 2));
      }
      const omitted = size - Buffer.byteLength(stubBody.slice(0, target), "utf8");
      if (omitted <= 0) continue;
      const cappedBody =
        `${stubBody.slice(0, target)}\n\n` +
        `[continuation byte cap: ${omitted} of ${size} bytes omitted; ` +
        "read the full comment through the API]";
      // A cap note is itself serialized text, and a body may already have
      // been slimmed to a reference: capping is only useful when it strictly
      // shrinks the serialized envelope. Anything else is rolled back —
      // without this monotonic guard the pass would grow the envelope one
      // note at a time and never converge.
      const previousBytes = bytes;
      shortened.set(message.id, { ...message, body: cappedBody });
      apply(rebuild());
      if (bytes < previousBytes) return true;
      shortened.delete(message.id);
      apply(rebuild());
    }
    return false;
  };

  // 3. Still over: shorten the largest bodies, non-pinned first. The cut is
  // deterministic, so a body capped here compares equal across runs and never
  // re-enters the resume delta.
  while (bytes > effectiveBudget && shortenLargest(false)) {
    // one largest body per iteration, until the envelope fits
  }

  // 4. The annotations this pass attaches (`messagesTruncated` plus the
  // appended notice) serialize into the same envelope and the same argv/env
  // string, so the ceiling must hold with them attached: keep shortening while
  // the annotated envelope is still over.
  const measure = (candidate: LimitedExecutionContinuationEnvelope) =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8");
  const withAnnotations = (
    candidate: LimitedExecutionContinuationEnvelope,
    overBudget: boolean,
  ): LimitedExecutionContinuationEnvelope => {
    const stats: ContinuationByteTruncation = {
      budgetBytes,
      beforeBytes,
      afterBytes: measure(candidate),
      bodiesReplaced: replaced.size,
      bodiesTruncated: shortened.size,
      messagesDropped: dropped.size,
      pinnedOverBudget: overBudget,
    };
    return {
      ...candidate,
      messagesTruncated: stats,
      truncationNotice: [
        candidate.truncationNotice,
        `Serialized continuation exceeded the ${budgetBytes}-byte envelope ceiling ` +
          `(${beforeBytes} before, ${stats.afterBytes} after): ` +
          `${stats.bodiesReplaced} older bodies became references, ` +
          `${stats.messagesDropped} referenced messages were dropped and ` +
          `${stats.bodiesTruncated} bodies were shortened. ` +
          (overBudget
            ? "The pinned direction alone is above the ceiling; the full text stays in the task thread."
            : "The full text stays in the task thread."),
      ]
        .filter(Boolean)
        .join(" "),
    };
  };

  let annotated = withAnnotations(current, false);
  for (let guard = 0; measure(annotated) > budgetBytes && guard < unique.length * 2 + 8; guard += 1) {
    if (!shortenLargest(false) && !shortenLargest(true)) {
      // Only pinned, already-minimal bodies remain: the ceiling cannot be met
      // without losing direction. Mark it loudly instead of trimming further.
      annotated = withAnnotations(current, true);
      break;
    }
    annotated = withAnnotations(current, false);
  }
  // The convergence loop above protects the pinned direction; a monotonic
  // result here means every annotation still fits the ceiling.
  if (measure(annotated) > budgetBytes && !annotated.messagesTruncated?.pinnedOverBudget) {
    annotated = withAnnotations(current, true);
  }
  return { envelope: annotated, stats: annotated.messagesTruncated ?? null };
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
  messageChars: number = readContinuationMessageChars(),
  messageBodyChars: number = readContinuationMessageBodyChars(),
  envelopeBytes: number = readContinuationEnvelopeBytes(),
): LimitedExecutionContinuationEnvelope {
  // 0 on every bound disables the bounded history; MYRMIDON_CONTINUATION_MESSAGE_CHARS=0
  // keeps the other bounds only.
  if (limit <= 0 && chars <= 0 && messageMaxChars <= 0 && messageChars <= 0 && envelopeBytes <= 0) return envelope;

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
  if (entries.length === 0 && !capped.stats) {
    // myrmidon(OPE-2321): the entry/character bounds did nothing, but the
    // serialized envelope may still sit above the byte ceiling — the byte pass
    // below is the last line of defence, so only bail out when it cannot act.
    if (envelopeBytes <= 0 || Buffer.byteLength(JSON.stringify(envelope), "utf8") <= envelopeBytes) {
      return envelope;
    }
  }

  const bounds: string[] = [];
  if (limit > 0) bounds.push(`the newest ${limit} entries per list`);
  if (chars > 0) bounds.push(`${chars} characters of message text`);
  const boundText = bounds.length > 0 ? bounds.join(" and ") : "the newest entries";
  const notices: string[] = [];
  if (entries.length > 0) {
    notices.push(
      `Task history was shortened to ${boundText} to keep the launch payload within process limits (long ` +
        "tasks must not grow the payload with their age). The original request, the latest request and the " +
        "comments that triggered this run are always included. Omitted entries: " +
        entries.map(([name, value]) => `${name} ${value.dropped} of ${value.total}`).join(", ") +
        `. Read the task thread through the API if you need the older entries: ${issueThreadReference(issueId)}.`,
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

  // myrmidon(OPE-2321): the serialized envelope must fit one argv/env string
  // (MAX_ARG_STRLEN counts UTF-8 bytes). Character budgets above cannot
  // guarantee that for non-ASCII history, so a final byte pass trims the
  // message list with the same pinned-direction guarantees. The pass attaches
  // `messagesTruncated` and the byte notice itself and converges with them
  // serialized into the envelope.
  return capMessagesBySerializedBytes(result, pinned, envelopeBytes, messageBodyChars).envelope;
}