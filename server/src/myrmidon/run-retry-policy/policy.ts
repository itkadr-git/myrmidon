// The run retry policy itself (1.6.6 RUN-RETRY-POLICY): one decision function
// that turns (failed run, attempt number) into either "retry at T, attempt N of
// M" or "do not retry, because of R".
//
// The four parts of the ticket meet here:
//
//   * classification — classifyRunFailureForRetry decides whether the failure
//     is retryable at all (a permanent failure is never scheduled, whatever the
//     attempt number says);
//   * the attempt limit — the ceiling comes from the settings and depends on
//     the class: a transient failure gets the transient budget, an unclassified
//     one the single default attempt, a permanent one none;
//   * the backoff — the delay of the next attempt comes from computeRunRetryBackoff;
//   * the counter — describeRunRetrySchedule is the snapshot the UI reads to
//     say "attempt N of M" instead of "attempt N".

import {
  computeRunRetryBackoff,
  DEFAULT_RUN_RETRY_POLICY,
  type RunRetryBackoff,
} from "./backoff.js";
import {
  classifyRunFailureForRetry,
  type RunFailureClass,
  type RunFailureClassification,
  type RunFailureClassificationReason,
  type RunFailureInput,
} from "./classification.js";
import type { RunRetryPolicySettings } from "./settings.js";

export type RunRetryDecisionReason =
  | "transient_failure_scheduled"
  | "policy_disabled"
  | "permanent_failure"
  | "attempt_limit_reached"
  | "attempt_limit_zero";

export type RunRetryDecision =
  | {
      retry: true;
      reason: "transient_failure_scheduled";
      classification: RunFailureClass;
      classificationReason: RunFailureClassificationReason;
      errorCode: string | null;
      errorFamily: string | null;
      attempt: number;
      maxAttempts: number;
      backoff: RunRetryBackoff;
      delayMs: number;
      dueAt: Date;
    }
  | {
      retry: false;
      reason: Exclude<RunRetryDecisionReason, "transient_failure_scheduled">;
      classification: RunFailureClass;
      classificationReason: RunFailureClassificationReason;
      errorCode: string | null;
      errorFamily: string | null;
      attempt: number;
      maxAttempts: number;
    };

/**
 * The attempt ceiling of a failure class. A permanent failure gets zero — the
 * decision below refuses it before the ceiling is even consulted, but making
 * the number explicit keeps the counter honest for a caller that only asks.
 */
export function resolveRunRetryMaxAttempts(
  classification: RunFailureClass,
  settings: RunRetryPolicySettings = DEFAULT_RUN_RETRY_POLICY,
): number {
  // A disabled policy queues nothing whatever the class is, so every caller
  // that asks for a ceiling gets the same answer as planRunRetry.
  if (!settings.enabled) return 0;
  if (classification === "permanent") return 0;
  if (classification === "unknown") return Math.max(0, settings.unknownMaxAttempts);
  return Math.max(0, settings.maxAttempts);
}

export interface PlanRunRetryInput {
  failure: RunFailureInput;
  /** 1-based number of the attempt about to be scheduled. */
  attempt: number;
  now: Date;
  settings?: RunRetryPolicySettings;
  random?: () => number;
}

export function planRunRetry(input: PlanRunRetryInput): RunRetryDecision {
  const settings = input.settings ?? DEFAULT_RUN_RETRY_POLICY;
  const failure: RunFailureClassification = classifyRunFailureForRetry(
    input.failure,
  );
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.floor(input.attempt))
    : 1;
  const maxAttempts = resolveRunRetryMaxAttempts(failure.classification, settings);
  const common = {
    classification: failure.classification,
    classificationReason: failure.reason,
    errorCode: failure.errorCode,
    errorFamily: failure.errorFamily,
    attempt,
    maxAttempts,
  };

  if (!settings.enabled) {
    return { retry: false, reason: "policy_disabled", ...common };
  }
  if (failure.classification === "permanent") {
    return { retry: false, reason: "permanent_failure", ...common };
  }
  if (maxAttempts <= 0) {
    return { retry: false, reason: "attempt_limit_zero", ...common };
  }
  if (attempt > maxAttempts) {
    return { retry: false, reason: "attempt_limit_reached", ...common };
  }

  const backoff = computeRunRetryBackoff({
    attempt,
    now: input.now,
    settings,
    random: input.random,
  });
  return {
    retry: true,
    reason: "transient_failure_scheduled",
    ...common,
    backoff,
    delayMs: backoff.delayMs,
    dueAt: backoff.dueAt,
  };
}

/**
 * What a scheduled retry records about itself, and what the board shows as the
 * attempt counter. It is deliberately a flat, JSON-safe object: it is written
 * into the retry run's `context_snapshot`, read back by the issue payload and
 * rendered by the run card — no schema change, no second source of truth.
 */
export interface RunRetryScheduleSnapshot {
  classification: RunFailureClass;
  classificationReason: RunFailureClassificationReason;
  errorCode: string | null;
  errorFamily: string | null;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  scheduledAt: string;
}

export interface DescribeRunRetryScheduleInput {
  failure: RunFailureInput;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  now: Date;
  settings?: RunRetryPolicySettings;
}

export function describeRunRetrySchedule(
  input: DescribeRunRetryScheduleInput,
): RunRetryScheduleSnapshot {
  const failure = classifyRunFailureForRetry(input.failure);
  const settings = input.settings ?? DEFAULT_RUN_RETRY_POLICY;
  return {
    classification: failure.classification,
    classificationReason: failure.reason,
    errorCode: failure.errorCode,
    errorFamily: failure.errorFamily,
    attempt: Math.max(1, Math.floor(finiteOr(input.attempt, 1))),
    maxAttempts: Math.max(
      0,
      Math.floor(
        finiteOr(input.maxAttempts, 0) > 0
          ? input.maxAttempts
          : resolveRunRetryMaxAttempts(failure.classification, settings),
      ),
    ),
    delayMs: Math.max(0, Math.floor(finiteOr(input.delayMs, 0))),
    scheduledAt: input.now.toISOString(),
  };
}

const RUN_FAILURE_CLASSES: readonly RunFailureClass[] = [
  "transient",
  "permanent",
  "unknown",
];

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return Number.NaN;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Tolerant reader of a persisted {@link RunRetryScheduleSnapshot}. Retry runs
 * queued before the policy existed carry no snapshot, and a hand-edited or
 * partially written one must never break the issue payload: anything that does
 * not look like a snapshot is simply `null`, and the callers fall back to the
 * bare attempt number.
 */
export function readRunRetryPolicySnapshot(
  value: unknown,
): RunRetryScheduleSnapshot | null {
  const snapshot = asRecord(value);
  if (!snapshot) return null;
  const classification = snapshot.classification;
  if (
    typeof classification !== "string" ||
    !RUN_FAILURE_CLASSES.includes(classification as RunFailureClass)
  ) {
    return null;
  }
  const classificationReason = snapshot.classificationReason;
  if (typeof classificationReason !== "string" || !classificationReason.trim()) {
    return null;
  }
  return {
    classification: classification as RunFailureClass,
    classificationReason:
      classificationReason as RunFailureClassificationReason,
    errorCode: stringOrNull(snapshot.errorCode),
    errorFamily: stringOrNull(snapshot.errorFamily),
    attempt: Math.max(1, Math.floor(finiteOr(asNumber(snapshot.attempt), 1))),
    maxAttempts: Math.max(
      0,
      Math.floor(finiteOr(asNumber(snapshot.maxAttempts), 0)),
    ),
    delayMs: Math.max(0, Math.floor(finiteOr(asNumber(snapshot.delayMs), 0))),
    scheduledAt: stringOrNull(snapshot.scheduledAt) ?? "",
  };
}