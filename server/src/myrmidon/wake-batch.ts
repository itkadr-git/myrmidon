import { extractWakeCommentIds } from "../modules/run-dispatch/index.js";

/**
 * Inbox batching: one run per window of comments on one task (1.6.6
 * INBOX-BATCH).
 *
 * A comment on an idle task wakes its agent at once: the comment-wake route
 * admits a wake, `enqueueWakeup` creates the run and
 * `startNextQueuedRunForAgent` claims it in the same tick. Three comments
 * written one after another — a review note, a correction, a question —
 * therefore start three runs, and each run spends a whole agent turn (a
 * container, a model call, a session) on one sentence.
 *
 * A task whose run is already on the execution path does not have this
 * problem: a second comment coalesces into the running execution
 * (`admitWakeBehindIssueExecution`) and both ids are merged in arrival order
 * (`mergeWakeCommentIds`), so the agent reads them together. This module
 * closes the idle case with a debounce window: a queued run whose wake is a
 * plain comment wake waits out `MYRMIDON_WAKE_BATCH_WINDOW_MS` before it is
 * claimed. `queued` is on the execution path, so a comment arriving inside the
 * window finds that waiting run as the task's execution and the ordinary
 * coalescing path appends its id to the run's `wakeCommentIds` — the run
 * starts once, carrying the whole window of comments in the order they were
 * written (1.6.6 INBOX-BATCH: several comments over a short window = one wake
 * with the full comment list).
 *
 * The window is not a queue and writes nothing of its own: a held run stays an
 * ordinary `queued` run, and the caller simply does not claim it yet. It is
 * retried when the window closes (the same one-per-process resweep the run
 * admission gates use), by the periodic queued-run sweep, and by any later
 * wake of the same agent — a missed timer costs the window, never the run.
 *
 * Never held:
 * - a wake the operator is waiting for: a harness checkout and an
 *   external-chat-bound run are runs someone is watching, not inbox noise;
 * - an interaction wake or an interaction continuation (any context that names
 *   an interaction): a card addressed to an agent has its own deadline and its
 *   own sweep, and delaying it delays a decision someone waits for;
 * - a wake that carries no comment id: there is nothing to aggregate, and the
 *   wake would only be late;
 * - `MYRMIDON_WAKE_BATCH_WINDOW_MS=0` (or `off`): the feature is off and every
 *   wake keeps the per-event delivery it had before.
 */

/** The window in milliseconds; `0`/`off` disables batching entirely. */
export const WAKE_BATCH_WINDOW_ENV = "MYRMIDON_WAKE_BATCH_WINDOW_MS";
/** Ten seconds: long enough to collect a burst of comments, short enough that a single one still feels immediate. */
export const DEFAULT_WAKE_BATCH_WINDOW_MS = 10_000;
/**
 * The longest window an operator may ask for (5 min). Past this the window is
 * no longer a debounce of a burst but a delay of the first comment, and the
 * inbox is better served by the ordinary per-event delivery.
 */
export const MAX_WAKE_BATCH_WINDOW_MS = 5 * 60_000;
/** A window shorter than the resolution of the resweep is not a window. */
export const MIN_WAKE_BATCH_WINDOW_MS = 250;

/**
 * The wake reasons that carry comments and nothing else — the same three the
 * wake queue folds together when it decides whether a queued wake is
 * comment-only (`queuedWakeIsCommentOnly` in the wake-queue adapter). A wake
 * with any other reason is a different event (an interaction, a status
 * change, a manual wake, an automation) and keeps its own delivery.
 */
export const COMMENT_WAKE_REASONS: readonly string[] = [
  "issue_commented",
  "issue_reopened_via_comment",
  "issue_comment_mentioned",
];

/** The keys that mark a wake as an interaction wake or an interaction continuation. */
const INTERACTION_CONTINUATION_CONTEXT_KEYS = [
  "interactionId",
  "interactionKind",
  "interactionStatus",
  "continuationPolicy",
  "checkboxSelection",
  "itemVerdicts",
  "newlyResolvedItemIds",
] as const;

/** heartbeat.ts: `paperclipHarnessCheckedOut` — the operator checked this run out by hand. */
const HARNESS_CHECKOUT_CONTEXT_KEY = "paperclipHarnessCheckedOut";
/** heartbeat.ts: `paperclipExternalChatExecutionBound` — a chat user is waiting on this run. */
const EXTERNAL_CHAT_EXECUTION_BOUND_CONTEXT_KEY =
  "paperclipExternalChatExecutionBound";

function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readCountEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "off" || raw === "false" || raw === "no") return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The debounce window in force in this process. Unset, empty or unparsable
 * falls back to the default; `0`/`off`/`false`/`no` is a real value that turns
 * batching off (so an operator can switch the feature off the way every other
 * myrmidon switch is switched off); a value above the maximum is capped.
 */
export function readWakeBatchWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = readCountEnv(env, WAKE_BATCH_WINDOW_ENV);
  if (configured === null) return DEFAULT_WAKE_BATCH_WINDOW_MS;
  if (configured === 0) return 0;
  return Math.min(Math.max(configured, MIN_WAKE_BATCH_WINDOW_MS), MAX_WAKE_BATCH_WINDOW_MS);
}

/** Why a queued run is not held, for the log line and for tests. */
export type WakeBatchSkipReason =
  | "disabled"
  | "not_a_comment_wake"
  | "no_comment_id"
  | "interaction"
  | "operator_is_waiting"
  | "window_elapsed";

export type WakeBatchEligibility =
  | { eligible: true; commentIds: string[] }
  | { eligible: false; reason: WakeBatchSkipReason };

/**
 * May this run's wake wait for the rest of its window? Pure: the caller hands
 * in the run's context snapshot. `commentIds` are returned in the order the
 * snapshot lists them — batching aggregates, it never reorders.
 */
export function classifyWakeBatchEligibility(
  contextSnapshot: unknown,
): WakeBatchEligibility {
  const context = parseObject(contextSnapshot);
  const commentIds = extractWakeCommentIds(context);
  const carriesComment =
    commentIds.length > 0 ||
    readNonEmptyString(context.wakeCommentId) !== null ||
    readNonEmptyString(context.commentId) !== null;
  if (!carriesComment) return { eligible: false, reason: "no_comment_id" };
  if (
    context[HARNESS_CHECKOUT_CONTEXT_KEY] === true ||
    context[EXTERNAL_CHAT_EXECUTION_BOUND_CONTEXT_KEY] === true
  ) {
    return { eligible: false, reason: "operator_is_waiting" };
  }
  if (
    context.resumeIntent === true ||
    INTERACTION_CONTINUATION_CONTEXT_KEYS.some(
      (key) => readNonEmptyString(context[key]) !== null,
    )
  ) {
    return { eligible: false, reason: "interaction" };
  }
  const wakeReason = readNonEmptyString(context.wakeReason);
  if (!wakeReason || !COMMENT_WAKE_REASONS.includes(wakeReason)) {
    return { eligible: false, reason: "not_a_comment_wake" };
  }
  return { eligible: true, commentIds };
}

/** One run the window holds back. */
export type WakeBatchHold = {
  runId: string;
  /** The task the waiting comments belong to, for the log line. */
  issueId: string | null;
  /** The comments already aggregated into the run, in arrival order. */
  commentIds: string[];
  /** The moment the window closes: `createdAt + windowMs`. */
  deadline: Date;
  remainingMs: number;
};

export type WakeBatchDecision =
  | { hold: true; batch: WakeBatchHold }
  | { hold: false; reason: WakeBatchSkipReason };

/**
 * Decides for one queued run whether it waits for the rest of its window.
 *
 * The window starts at the run's own `createdAt`, not at the first comment the
 * wake carried: the run and its comment appear together, so the two are the
 * same instant, and a run re-created for a retry starts a fresh window rather
 * than inheriting the age of the wake that caused it.
 */
export function decideWakeBatchHold(input: {
  run: { id: string; createdAt: Date; contextSnapshot: unknown };
  now: Date;
  windowMs: number;
}): WakeBatchDecision {
  const windowMs = Math.max(0, input.windowMs);
  if (!(windowMs > 0)) return { hold: false, reason: "disabled" };
  const eligibility = classifyWakeBatchEligibility(input.run.contextSnapshot);
  if (!eligibility.eligible) return { hold: false, reason: eligibility.reason };
  const deadline = new Date(input.run.createdAt.getTime() + windowMs);
  const remainingMs = deadline.getTime() - input.now.getTime();
  if (remainingMs <= 0) return { hold: false, reason: "window_elapsed" };
  return {
    hold: true,
    batch: {
      runId: input.run.id,
      issueId: readNonEmptyString(parseObject(input.run.contextSnapshot).issueId),
      commentIds: eligibility.commentIds,
      deadline,
      remainingMs,
    },
  };
}

export type WakeBatchSplit<T> = {
  /** The runs this pass may claim, in the order it received them. */
  runnable: T[];
  /** The runs the window holds back, in the order it received them. */
  held: WakeBatchHold[];
  /** Delay for the resweep that retries the held runs, or `null` when none is held. */
  resweepDelayMs: number | null;
};

/**
 * Splits this agent's queued runs into the ones a pass may claim and the ones
 * their window still holds. Held runs are left out of the claim pass entirely
 * rather than skipped inside it: the admission counts slots for the runs it is
 * offered, so a held run must not take one. The resweep delay is the deadline
 * of the earliest held run, so one timer serves the whole queue; a run whose
 * own window already closed when the pass reaches it is not in the way of the
 * runs behind it.
 */
export function splitBatchedWakeRuns<
  T extends { id: string; createdAt: Date; contextSnapshot: unknown },
>(runs: readonly T[], options: { now: Date; windowMs: number }): WakeBatchSplit<T> {
  const windowMs = Math.max(0, options.windowMs);
  if (!(windowMs > 0)) {
    return { runnable: [...runs], held: [], resweepDelayMs: null };
  }
  const runnable: T[] = [];
  const held: WakeBatchHold[] = [];
  let earliestDeadlineMs: number | null = null;
  for (const run of runs) {
    const decision = decideWakeBatchHold({ run, now: options.now, windowMs });
    if (!decision.hold) {
      runnable.push(run);
      continue;
    }
    held.push(decision.batch);
    earliestDeadlineMs =
      earliestDeadlineMs === null
        ? decision.batch.deadline.getTime()
        : Math.min(earliestDeadlineMs, decision.batch.deadline.getTime());
  }
  return {
    runnable,
    held,
    resweepDelayMs:
      earliestDeadlineMs === null ? null : Math.max(earliestDeadlineMs - options.now.getTime(), 0),
  };
}