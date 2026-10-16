// Exponential backoff of the run retry policy (1.6.6 RUN-RETRY-POLICY).
//
// delay(attempt) = min(base * multiplier ** (attempt - 1), ceiling), then a
// symmetric jitter of +/- jitterRatio. Attempts are 1-based: the first retry
// waits `base`, the second `base * multiplier`, and so on.
//
// Three properties matter and are all tested:
//
//   * the ceiling is applied before the jitter, so a spread never lifts a wait
//     above the operator's ceiling by more than the jitter itself;
//   * a delay never falls below MIN_RUN_RETRY_DELAY_MS — a retry scheduled into
//     the same instant as the failure is a busy loop, not a backoff;
//   * the random source is injected, so a test (and any caller that wants a
//     reproducible schedule) can pin the jitter.

import {
  DEFAULT_RUN_RETRY_BASE_DELAY_SEC,
  DEFAULT_RUN_RETRY_JITTER_PERCENT,
  DEFAULT_RUN_RETRY_MAX_DELAY_SEC,
  DEFAULT_RUN_RETRY_MULTIPLIER,
  type RunRetryPolicySettings,
} from "./settings.js";

/** A retry is never due immediately, whatever the jitter does. */
export const MIN_RUN_RETRY_DELAY_MS = 1000;

/** The pre-policy numbers, as a settings object: useful for callers and tests. */
export const DEFAULT_RUN_RETRY_POLICY: RunRetryPolicySettings = {
  enabled: true,
  maxAttempts: 3,
  unknownMaxAttempts: 1,
  baseDelayMs: DEFAULT_RUN_RETRY_BASE_DELAY_SEC * 1000,
  multiplier: DEFAULT_RUN_RETRY_MULTIPLIER,
  maxDelayMs: DEFAULT_RUN_RETRY_MAX_DELAY_SEC * 1000,
  jitterRatio: DEFAULT_RUN_RETRY_JITTER_PERCENT / 100,
};

export interface RunRetryBackoff {
  /** 1-based attempt this delay belongs to (clamped to at least 1). */
  attempt: number;
  /** base * multiplier ** (attempt - 1) before the ceiling and the jitter. */
  rawDelayMs: number;
  /** The delay after the ceiling and the jitter — what the schedule uses. */
  delayMs: number;
  /** The delay hit the ceiling (the jitter, if any, is applied on top). */
  capped: boolean;
  jittered: boolean;
  /** The one moment the caller needs: when the next attempt is due. */
  dueAt: Date;
}

export interface ComputeRunRetryBackoffInput {
  attempt: number;
  now: Date;
  settings?: RunRetryPolicySettings;
  /** Injectable random source in [0, 1); defaults to Math.random. */
  random?: () => number;
}

export function computeRunRetryBackoff(
  input: ComputeRunRetryBackoffInput,
): RunRetryBackoff {
  const settings = input.settings ?? DEFAULT_RUN_RETRY_POLICY;
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.floor(input.attempt))
    : 1;
  const exponent = attempt - 1;
  const rawDelayMs = Math.round(
    settings.baseDelayMs * Math.pow(settings.multiplier, exponent),
  );
  const ceiling = Math.max(0, Math.floor(settings.maxDelayMs));
  const capped = rawDelayMs > ceiling;
  const cappedDelayMs = capped ? ceiling : rawDelayMs;

  const jitterRatio = Math.max(0, settings.jitterRatio);
  const random = input.random ?? Math.random;
  const jittered = jitterRatio > 0;
  const factor = jittered ? 1 + (random() * 2 - 1) * jitterRatio : 1;
  const delayMs = Math.max(
    MIN_RUN_RETRY_DELAY_MS,
    Math.round(cappedDelayMs * factor),
  );

  return {
    attempt,
    rawDelayMs,
    delayMs,
    capped,
    jittered,
    dueAt: new Date(input.now.getTime() + delayMs),
  };
}