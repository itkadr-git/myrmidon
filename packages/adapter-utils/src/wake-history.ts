import type { ExecutionContinuationEnvelope } from "@myrmidon/shared";

// WAKE-HISTORY: how much task history one wake prompt carries.
//
// The execution-continuation envelope holds the task thread (up to 30 messages
// / ~24k characters after the server-side history limit). Before this module
// that history reached the model three times in one gateway request: the
// rendered "Current request and continuation context" block, and again as
// `executionContinuation.messages` and `executionContinuation.resumeDelta.messages`
// inside the "Structured wake payload JSON" block (a 102k-character wake whose
// useful summary was 2k). This module is the single place that decides what
// history a wake carries:
//
//   - the rendered prompt carries the history ONCE, in the mode the agent's card
//     asks for (`wakeHistory`);
//   - the structured JSON copy never repeats it (see `stripContinuationHistoryForJson`)
//     and is itself capped (see `capWakePayloadJson`).

/**
 * - `summary`: no raw messages; previous run, its status, the completed-work
 *   summary and the open interactions. For agents that start a fresh session on
 *   every run (`sessionKeyStrategy` run | none).
 * - `recent`: the newest few messages, once, shortened.
 * - `full`: the envelope as the server built it (legacy; already bounded by the
 *   server-side continuation history limit).
 */
export type PaperclipWakeHistoryMode = "summary" | "recent" | "full";

export const MYRMIDON_WAKE_SUMMARY_MAX_CHARS = 2_000;
export const MYRMIDON_WAKE_RECENT_MAX_MESSAGES = 8;
export const MYRMIDON_WAKE_RECENT_MESSAGE_MAX_CHARS = 1_000;
export const MYRMIDON_WAKE_RECENT_TOTAL_MAX_CHARS = 8_000;
export const MYRMIDON_WAKE_PAYLOAD_JSON_MAX_CHARS = 12_000;

type Message = ExecutionContinuationEnvelope["messages"][number];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The history mode of one agent card. An explicit `wakeHistory` wins; otherwise
 * the session strategy decides: a card whose session is new on every run
 * (`run`, `none`) has no earlier session to lean on, and by owner decision its
 * agent does not load previous runs, so it gets the summary only. Every other
 * card keeps a short, bounded tail of the thread.
 */
export function resolvePaperclipWakeHistoryMode(config: unknown): PaperclipWakeHistoryMode {
  const cfg = asRecord(config);
  const explicit = typeof cfg.wakeHistory === "string" ? cfg.wakeHistory.trim().toLowerCase() : "";
  if (explicit === "summary" || explicit === "recent" || explicit === "full") return explicit;
  const strategy = typeof cfg.sessionKeyStrategy === "string" ? cfg.sessionKeyStrategy.trim().toLowerCase() : "";
  return strategy === "run" || strategy === "none" ? "summary" : "recent";
}

function issueThreadPointer(issueId: string | null | undefined): string {
  const id = typeof issueId === "string" && issueId.trim() ? issueId.trim() : null;
  return id ? `GET /api/issues/${id}/comments (oldest first)` : "the task thread through the issue API";
}

function cutAt(text: string, length: number): string {
  if (length >= text.length) return text;
  if (length <= 0) return "";
  // Never end on half of a surrogate pair.
  const code = text.charCodeAt(length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, length - 1) : text.slice(0, length);
}

/** Cuts `text` to at most `maxChars` characters, marker included. */
export function truncateWakeText(text: string, maxChars: number, where: string): string {
  if (text.length <= maxChars) return text;
  const marker = (omitted: number) => `\n[wake cap: ${omitted} characters omitted; ${where}]`;
  const keep = Math.max(0, maxChars - marker(text.length).length);
  return `${cutAt(text, keep)}${marker(text.length - cutAt(text, keep).length)}`;
}

/** What the history reduction did, reported inside the rendered envelope. */
export interface PaperclipWakeHistoryNote {
  mode: Exclude<PaperclipWakeHistoryMode, "full">;
  messagesIncluded: number;
  messagesOmitted: number;
  bodiesShortened: number;
  thread: string;
}

export type SlimExecutionContinuation = ExecutionContinuationEnvelope & {
  wakeHistory: PaperclipWakeHistoryNote;
};

function isHumanRequest(message: Message): boolean {
  return (
    message.authorType === "user" &&
    !message.createdByRunId &&
    !message.deleted &&
    typeof message.body === "string" &&
    message.body.trim().length > 0
  );
}

function selectRecentMessages(
  messages: Message[],
  originCommentIds: string[],
  issueId: string,
): { items: Message[]; shortened: number } {
  const pinned = new Set<string>(originCommentIds);
  const latestRequest = messages.findLast(isHumanRequest);
  if (latestRequest) pinned.add(latestRequest.id);

  // Direction first (the comments this run was woken for and the latest human
  // request), then the newest of the rest, up to the message cap.
  const chosen = new Set<number>();
  for (let index = messages.length - 1; index >= 0 && chosen.size < MYRMIDON_WAKE_RECENT_MAX_MESSAGES; index--) {
    if (pinned.has(messages[index]!.id)) chosen.add(index);
  }
  for (let index = messages.length - 1; index >= 0 && chosen.size < MYRMIDON_WAKE_RECENT_MAX_MESSAGES; index--) {
    chosen.add(index);
  }

  const where = `full text: ${issueThreadPointer(issueId)}`;
  let shortened = 0;
  const items = [...chosen]
    .sort((a, b) => a - b)
    .map((index) => {
      const message = messages[index]!;
      if (typeof message.body !== "string" || message.body.length <= MYRMIDON_WAKE_RECENT_MESSAGE_MAX_CHARS) return message;
      shortened++;
      return { ...message, body: truncateWakeText(message.body, MYRMIDON_WAKE_RECENT_MESSAGE_MAX_CHARS, where) };
    });

  // Total budget: drop the oldest entries that carry no direction until it fits.
  const total = () => items.reduce((sum, message) => sum + (typeof message.body === "string" ? message.body.length : 0), 0);
  while (total() > MYRMIDON_WAKE_RECENT_TOTAL_MAX_CHARS) {
    const droppable = items.findIndex((message) => !pinned.has(message.id));
    if (droppable < 0) break;
    items.splice(droppable, 1);
  }
  return { items, shortened };
}

const SAME_AS_CONTINUATION_SUMMARY =
  "[identical to the 'Issue continuation summary' section of this prompt]";

/**
 * The continuation context of one wake in `summary` or `recent` mode. Every key
 * of the envelope stays; only the message list is reduced, `completedWork` is
 * capped (summary) or de-duplicated against the continuation summary, and a
 * `wakeHistory` note says what was left out and where it can be read.
 */
export function slimExecutionContinuationHistory(
  continuation: ExecutionContinuationEnvelope,
  mode: Exclude<PaperclipWakeHistoryMode, "full">,
  options: { continuationSummaryBody?: string | null } = {},
): SlimExecutionContinuation {
  const source = Array.isArray(continuation.messages) ? continuation.messages : [];
  const thread = issueThreadPointer(continuation.issueId);
  const selected =
    mode === "summary"
      ? { items: [] as Message[], shortened: 0 }
      : selectRecentMessages(source, continuation.originCommentIds ?? [], continuation.issueId);

  let completedWork = continuation.completedWork;
  if (typeof completedWork === "string") {
    const summaryBody = options.continuationSummaryBody?.trim() ?? "";
    if (summaryBody && completedWork.trim() === summaryBody) {
      completedWork = SAME_AS_CONTINUATION_SUMMARY;
    } else if (mode === "summary") {
      completedWork = truncateWakeText(completedWork, MYRMIDON_WAKE_SUMMARY_MAX_CHARS, "the full text is in the previous run result");
    }
  }

  return {
    ...continuation,
    messages: selected.items,
    completedWork,
    coverage: { ...continuation.coverage, kind: mode === "summary" ? "summary_only" : "recent_messages" },
    wakeHistory: {
      mode,
      messagesIncluded: selected.items.length,
      messagesOmitted: source.length - selected.items.length,
      bodiesShortened: selected.shortened,
      thread,
    },
  };
}

/** The sentence that tells the model what the reduced history is. */
export function describeWakeHistory(note: PaperclipWakeHistoryNote): string {
  return note.mode === "summary"
    ? "Earlier task messages are not part of this wake (wake history: summary). It carries the current objective, " +
        "the comments that triggered this run, the previous run with its final status, the completed-work summary " +
        `and the open interactions. Read the task thread when you need older messages: ${note.thread}.`
    : `Only the newest ${note.messagesIncluded} task messages are included, long bodies shortened (wake history: recent); ` +
        `${note.messagesOmitted} older messages stay in the task thread: ${note.thread}. ` +
        "A summary has no certified message coverage; use the source messages to resolve omissions.";
}

/** Cap for the continuation summary body rendered in `summary` mode. */
export function capWakeSummaryBody(body: string, mode: PaperclipWakeHistoryMode): { body: string; truncated: boolean } {
  if (mode !== "summary" || body.length <= MYRMIDON_WAKE_SUMMARY_MAX_CHARS) return { body, truncated: false };
  return {
    body: truncateWakeText(body, MYRMIDON_WAKE_SUMMARY_MAX_CHARS, "the full summary is the issue continuation-summary document"),
    truncated: true,
  };
}

export type ContinuationJsonStub = ExecutionContinuationEnvelope & {
  omittedFromJson: { reason: string; fields: string[]; messages: number; resumeDeltaMessages: number };
};

/**
 * The JSON copy of the wake payload travels in the same prompt as the rendered
 * wake text, which already carries the continuation context (history, and the
 * "untrusted continuation evidence" block). The JSON keeps the shape, identity
 * and cursors of the envelope and drops the bulky parts that would repeat.
 */
export function stripContinuationHistoryForJson(envelope: ExecutionContinuationEnvelope): ContinuationJsonStub {
  const resumeDeltaMessages = envelope.resumeDelta?.messages?.length ?? 0;
  const { resumeDelta, ...rest } = envelope;
  return {
    ...rest,
    messages: [],
    ...(resumeDelta ? { resumeDelta: { baseRunId: resumeDelta.baseRunId, messages: [] } } : {}),
    interactionOutcomes: [],
    completedWork: null,
    ...(envelope.completedActions ? { completedActions: [] } : {}),
    ...(envelope.recoveryOutcomes ? { recoveryOutcomes: [] } : {}),
    omittedFromJson: {
      reason: "rendered once in the 'Current request and continuation context' section of this prompt",
      fields: [
        "messages",
        "resumeDelta.messages",
        "interactionOutcomes",
        "completedWork",
        "completedActions",
        "recoveryOutcomes",
      ],
      messages: Array.isArray(envelope.messages) ? envelope.messages.length : 0,
      resumeDeltaMessages,
    },
  };
}

// Top-level keys the size cap may empty. Everything else is a small flag, id or
// counter that the guards and the prompt rely on, and always stays.
const CAPPABLE_WAKE_PAYLOAD_KEYS = [
  "executionContinuation",
  "comments",
  "eventDigest",
  "childIssueSummaries",
  "annotationDeltas",
  "planReviewContext",
  "documentReviewContext",
  "continuationSummary",
  "taskWatchdog",
  "unresolvedBlockerSummaries",
  "questionResponse",
  "externalChatQuestionResponse",
  "agentMessage",
] as const;

/**
 * Serializes the structured wake payload within `maxChars` (0 disables the cap).
 * Over the limit, the largest cappable keys are emptied one by one (arrays to
 * `[]`, objects to `null`) and a `jsonTruncation` key names them, so the model
 * is told what the JSON no longer carries instead of seeing a silently shorter
 * payload. The rendered prompt text is not affected.
 */
export function capWakePayloadJson(
  payload: Record<string, unknown>,
  maxChars: number = MYRMIDON_WAKE_PAYLOAD_JSON_MAX_CHARS,
): string {
  const original = JSON.stringify(payload);
  if (maxChars <= 0 || original.length <= maxChars) return original;

  const next: Record<string, unknown> = { ...payload };
  const droppedKeys: string[] = [];
  const marker = () => ({
    reason: `structured wake payload exceeded ${maxChars} characters; the listed keys were emptied (the prompt text above still carries the wake; read the issue API for more)`,
    limitChars: maxChars,
    originalChars: original.length,
    droppedKeys,
  });
  const serialize = () => JSON.stringify({ ...next, jsonTruncation: marker() });

  const candidates = CAPPABLE_WAKE_PAYLOAD_KEYS
    .filter((key) => {
      const value = next[key];
      return value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0);
    })
    .map((key) => ({ key, size: JSON.stringify(next[key]).length }))
    .sort((a, b) => b.size - a.size);

  let result = serialize();
  for (const { key } of candidates) {
    if (result.length <= maxChars) break;
    next[key] = Array.isArray(next[key]) ? [] : null;
    droppedKeys.push(key);
    result = serialize();
  }

  // Last resort: a very long issue description.
  const issue = asRecord(next.issue);
  if (result.length > maxChars && typeof issue.description === "string" && issue.description.length > 0) {
    const overshoot = result.length - maxChars;
    const keep = Math.max(0, issue.description.length - overshoot - 64);
    next.issue = { ...issue, description: cutAt(issue.description, keep), descriptionTruncated: true };
    droppedKeys.push("issue.description");
    result = serialize();
  }
  return result;
}
