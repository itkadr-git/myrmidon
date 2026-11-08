import { agents } from "@myrmidon/db";
import { asBoolean, parseObject } from "../adapters/utils.js";
import {
  classifyRunFailureForRetry,
  computeRunRetryBackoff,
  DEFAULT_RUN_RETRY_POLICY,
  resolveRunRetryMaxAttempts,
  type RunFailureClassification,
  type RunRetryPolicySettings,
} from "../myrmidon/run-retry-policy/index.js";

export function isHeartbeatWakeOnDemandEnabled(
  agent: Pick<typeof agents.$inferSelect, "runtimeConfig">,
) {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const heartbeat = parseObject(runtimeConfig.heartbeat);
  return asBoolean(
    heartbeat.wakeOnDemand ??
      heartbeat.wakeOnAssignment ??
      heartbeat.wakeOnOnDemand ??
      heartbeat.wakeOnAutomation,
    true,
  );
}

// ─── Unified task retry policy (1.7 RETRY-TASK-POLICY) ────────────────────────
//
// After RETRY-UNIFIED (server/src/myrmidon/run-retry-policy), the task-level
// heartbeat decides "retry or not, and when" through this one module. The
// contract mirrors the ticket:
//
//   * exponential backoff with jitter and a ceiling — computeRunRetryBackoff
//     from RETRY-UNIFIED, so the task schedule and the run schedule share the
//     arithmetic (ceiling applied before the jitter: a spread never lifts a
//     wait above the operator ceiling by more than the jitter itself);
//   * an attempt counter per issue/run — a "real" attempt is one that reached a
//     dispatch; failures classified before dispatch (adapter down, permanent
//     failure, policy disabled) never move the counter;
//   * one wake reason — every task retry decision carries
//     TASK_RETRY_WAKE_REASON, so the scheduler, the rewake throttle and the
//     board see a single reason instead of a family of per-path strings;
//   * determinism — the same ordered series of error codes for the same
//     issue/run yields the same ordered series of decisions. The jitter random
//     source is injectable; the default is seeded by the fingerprint of the
//     series so a series is reproducible without a caller-supplied source.

/** The single wake reason every task retry decision carries. */
export const TASK_RETRY_WAKE_REASON = "transient_failure_retry";

/** Durable reason recorded beside the wake reason in counters/snapshots. */
export const TASK_RETRY_REASON = "transient_failure";

export type TaskRetryDecisionReason =
  | "transient_failure_scheduled"
  | "success"
  | "pre_dispatch_limit_reached"
  | "policy_disabled"
  | "permanent_failure"
  | "attempt_limit_reached"
  | "attempt_limit_zero";

export type TaskRetryDecision =
  | {
      retry: true;
      reason: "transient_failure_scheduled";
      /** The one wake reason the scheduler wakes with. */
      wakeReason: typeof TASK_RETRY_WAKE_REASON;
      retryReason: typeof TASK_RETRY_REASON;
      classification: RunFailureClassification["classification"];
      classificationReason: RunFailureClassification["reason"];
      errorCode: string | null;
      errorFamily: string | null;
      /** 1-based attempt this decision schedules. */
      attempt: number;
      /** The attempt counter as it stands after this decision. */
      attemptCount: number;
      maxAttempts: number;
      rawDelayMs: number;
      delayMs: number;
      dueAt: Date;
      /**
       * Fingerprint of the failure series so far; the counter and the jitter
       * seed both derive from the series, never from wall-clock time.
       */
      seriesFingerprint: string;
    }
  | {
      retry: false;
      reason: Exclude<TaskRetryDecisionReason, "transient_failure_scheduled">;
      wakeReason: null;
      retryReason: null;
      classification: RunFailureClassification["classification"];
      classificationReason: RunFailureClassification["reason"];
      errorCode: string | null;
      errorFamily: string | null;
      attempt: number;
      attemptCount: number;
      maxAttempts: number;
      seriesFingerprint: string;
    };

export interface TaskRetryAttemptFailure {
  /** Error code of the failure that this attempt produced (the series). */
  errorCode?: string | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
  /** True when this failure happened before dispatch — not a real attempt. */
  beforeDispatch?: boolean;
  /** True when the run succeeded; resets the counter for the next failure. */
  succeeded?: boolean;
}

export interface TaskRetryState {
  /** Attempts that reached a dispatch, in order. */
  attempts: TaskRetryAttemptFailure[];
}

export interface PlanTaskRetryInput {
  issueId: string;
  runId?: string | null;
  failure: TaskRetryAttemptFailure;
  /**
   * Ordered history of the failure series so far (oldest first). Each entry
   * is what one attempt failed with; an entry may carry `beforeDispatch` for
   * pre-dispatch failures, which do not count as attempts.
   */
  series: TaskRetryAttemptFailure[];
  /** Prior state (counter); superseded by `series` when both are given. */
  state?: TaskRetryState;
  now: Date;
  settings?: RunRetryPolicySettings;
  /** Injectable random source; default: seeded from the series fingerprint. */
  random?: () => number;
}

/**
 * Fingerprint of the ordered failure series: FNV-1a over the normalized code
 * sequence. Two runs of the same task with the same series of codes produce
 * the same fingerprint, which seeds the jitter below — determinism without
 * any wall-clock or Math.random input.
 */
export function taskRetrySeriesFingerprint(
  series: readonly TaskRetryAttemptFailure[],
): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const entry of series) {
    mix(String(entry.errorCode ?? "").trim().toLowerCase() || "unknown");
    mix(entry.beforeDispatch ? ":pre" : ":real");
    mix(entry.succeeded ? ":ok" : ":fail");
    mix("|");
  }
  return `taskretry-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Deterministic random source derived from a seed string (mulberry32). */
function seededRandom(seed: string): () => number {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) {
    state = (Math.imul(state, 31) + seed.charCodeAt(i)) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function countRealAttempts(series: readonly TaskRetryAttemptFailure[]): number {
  let count = 0;
  for (const entry of series) {
    if (entry.beforeDispatch) continue;
    if (entry.succeeded) {
      // A success discharges the counter: the next failure starts from zero.
      count = 0;
      continue;
    }
    count += 1;
  }
  return count;
}

/** Pre-dispatch failures in the series — the budget that bounds them. */
function countPreDispatchFailures(
  series: readonly TaskRetryAttemptFailure[],
): number {
  let count = 0;
  for (const entry of series) {
    if (entry.beforeDispatch && !entry.succeeded) count += 1;
  }
  return count;
}

function resolveMaxAttempts(
  classification: RunFailureClassification["classification"],
  settings: RunRetryPolicySettings,
): number {
  if (!settings.enabled) return 0;
  if (classification === "permanent") return 0;
  if (classification === "unknown") return Math.max(0, settings.unknownMaxAttempts);
  return Math.max(0, settings.maxAttempts);
}

/**
 * The one decision function for task retries. Input is the failure the task
 * just produced plus the ordered series of failures so far; the output is
 * either "retry at T, attempt N of M" or "do not retry, because of R" — with
 * the attempt counter, the unified wake reason, and the series fingerprint
 * carried on every decision so consumers never recompute them.
 *
 * Determinism: for a fixed ordered series of error codes, `planTaskRetry`
 * returns the same ordered series of decisions. The jitter seed is the series
 * fingerprint, so even the default random source is reproducible.
 */
export function planTaskRetry(input: PlanTaskRetryInput): TaskRetryDecision {
  const settings = input.settings ?? DEFAULT_RUN_RETRY_POLICY;
  const series = input.series ?? input.state?.attempts ?? [];
  const seriesWithCurrent = [...series, input.failure];

  const failure = classifyRunFailureForRetry({
    errorCode: input.failure.errorCode ?? null,
    errorFamily: input.failure.errorFamily ?? null,
    errorMessage: input.failure.errorMessage ?? null,
  });

  const common = {
    classification: failure.classification,
    classificationReason: failure.reason,
    errorCode: failure.errorCode,
    errorFamily: failure.errorFamily,
  };

  // A success resets the counter, and nothing is scheduled for it.
  if (input.failure.succeeded) {
    return {
      retry: false,
      reason: "success",
      wakeReason: null,
      retryReason: null,
      ...common,
      attempt: 1,
      attemptCount: 0,
      maxAttempts: resolveRunRetryMaxAttempts(
        failure.classification,
        settings,
      ),
      seriesFingerprint: taskRetrySeriesFingerprint(seriesWithCurrent),
    };
  }

  // Pre-dispatch failures are not attempts: the counter does not move, but
  // the retry is still scheduled with the same reason and backoff.
  const attemptCountBefore = countRealAttempts(series);
  const attempt = input.failure.beforeDispatch
    ? Math.max(1, attemptCountBefore)
    : attemptCountBefore + 1;
  const attemptCountAfter = countRealAttempts(seriesWithCurrent);

  const maxAttempts = resolveRunRetryMaxAttempts(
    failure.classification,
    settings,
  );
  const seriesFingerprint = taskRetrySeriesFingerprint(seriesWithCurrent);

  if (!settings.enabled) {
    return {
      retry: false,
      reason: "policy_disabled",
      wakeReason: null,
      retryReason: null,
      ...common,
      attempt,
      attemptCount: attemptCountAfter,
      maxAttempts,
      seriesFingerprint,
    };
  }
  if (failure.classification === "permanent") {
    return {
      retry: false,
      reason: "permanent_failure",
      wakeReason: null,
      retryReason: null,
      ...common,
      attempt,
      attemptCount: attemptCountAfter,
      maxAttempts,
      seriesFingerprint,
    };
  }
  if (maxAttempts <= 0) {
    return {
      retry: false,
      reason: "attempt_limit_zero",
      wakeReason: null,
      retryReason: null,
      ...common,
      attempt,
      attemptCount: attemptCountAfter,
      maxAttempts,
      seriesFingerprint,
    };
  }
  if (input.failure.beforeDispatch) {
    // Pre-dispatch failures bypass the attempt counter but only within their
    // own budget, so an adapter that never dispatches cannot spin for ever on
    // "the counter never moves". `maxAttempts` (not the classification ceiling)
    // is the shared bound: once the transcript carries maxAttempts consecutive
    // pre-dispatch failures with no intervening real attempt, the schedule
    // stops queueing new ones.
    if (countPreDispatchFailures(series) >= Math.max(0, settings.maxAttempts)) {
      return {
        retry: false,
        reason: "pre_dispatch_limit_reached",
        wakeReason: null,
        retryReason: null,
        ...common,
        attempt,
        attemptCount: attemptCountAfter,
        maxAttempts,
        seriesFingerprint,
      };
    }
  } else if (attempt > maxAttempts) {
    return {
      retry: false,
      reason: "attempt_limit_reached",
      wakeReason: null,
      retryReason: null,
      ...common,
      attempt,
      attemptCount: attemptCountAfter,
      maxAttempts,
      seriesFingerprint,
    };
  }

  const backoff = computeRunRetryBackoff({
    attempt,
    now: input.now,
    settings,
    random: input.random ?? seededRandom(seriesFingerprint),
  });

  return {
    retry: true,
    reason: "transient_failure_scheduled",
    wakeReason: TASK_RETRY_WAKE_REASON,
    retryReason: TASK_RETRY_REASON,
    ...common,
    attempt,
    attemptCount: attemptCountAfter,
    maxAttempts,
    rawDelayMs: backoff.rawDelayMs,
    delayMs: backoff.delayMs,
    dueAt: backoff.dueAt,
    seriesFingerprint,
  };
}

/**
 * Collapse an ordered series of failures into the decision series — the
 * function the determinism test drives. Each entry of `series` is one
 * failure in order; the result has one decision per failure, computed with
 * the history that precedes it. Two calls with the same series return deep-
 * equal results (same delays, same counters, same fingerprints).
 */
export function planTaskRetrySeries(
  input: {
    issueId: string;
    runId?: string | null;
    series: TaskRetryAttemptFailure[];
    now: Date;
    settings?: RunRetryPolicySettings;
    random?: () => number;
  },
): TaskRetryDecision[] {
  const decisions: TaskRetryDecision[] = [];
  let history: TaskRetryAttemptFailure[] = [];
  for (const failure of input.series) {
    decisions.push(
      planTaskRetry({
        issueId: input.issueId,
        runId: input.runId,
        failure,
        series: history,
        now: input.now,
        settings: input.settings,
        random: input.random,
      }),
    );
    history = [...history, failure];
  }
  return decisions;
}
