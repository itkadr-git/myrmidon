// Run retry policy settings (MYRMIDON_RUN_RETRY_*). See docs/myrmidon/SETTINGS.md.
//
// 1.6.6 RUN-RETRY-POLICY: one place that answers the three questions a failed
// run raises — is this failure retryable at all, how long does the board wait
// before the next attempt, and how many attempts may the issue spend.
//
// The defaults reproduce the numbers the retry paths used before the policy
// existed: a 60 s base, a factor of 2, three attempts for a transient failure
// and one for an unclassified one. Enabling the module therefore changes no
// schedule by itself; the ceiling and the jitter are the two knobs an operator
// reaches for when a retry storm or a thundering herd shows up.
//
// The module is a defect fix (CONVENTIONS.md §8): it ships enabled, and only an
// explicit off value disables it (MYRMIDON_RUN_STALL_ENABLED follows the same
// rule — a typo must not silently extinguish the policy).

export const RUN_RETRY_ENABLED_ENV = "MYRMIDON_RUN_RETRY_ENABLED";
export const RUN_RETRY_MAX_ATTEMPTS_ENV = "MYRMIDON_RUN_RETRY_MAX_ATTEMPTS";
export const RUN_RETRY_UNKNOWN_MAX_ATTEMPTS_ENV =
  "MYRMIDON_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS";
export const RUN_RETRY_BASE_DELAY_SEC_ENV = "MYRMIDON_RUN_RETRY_BASE_DELAY_SEC";
export const RUN_RETRY_MULTIPLIER_ENV = "MYRMIDON_RUN_RETRY_MULTIPLIER";
export const RUN_RETRY_MAX_DELAY_SEC_ENV = "MYRMIDON_RUN_RETRY_MAX_DELAY_SEC";
export const RUN_RETRY_JITTER_PERCENT_ENV = "MYRMIDON_RUN_RETRY_JITTER_PERCENT";

/** Attempts a transient (retryable) failure may spend. */
export const DEFAULT_RUN_RETRY_MAX_ATTEMPTS = 3;
export const MAX_RUN_RETRY_MAX_ATTEMPTS = 10;

/**
 * Attempts an unclassified failure may spend. One, not zero: a failure whose
 * class the board cannot name still deserves the single continuation the
 * recovery sweep has always given it, but it must not inherit the transient
 * budget — that is what the classification is for.
 */
export const DEFAULT_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS = 1;

/** 60 s: the base backoff the continuation recovery used. */
export const DEFAULT_RUN_RETRY_BASE_DELAY_SEC = 60;
export const MIN_RUN_RETRY_BASE_DELAY_SEC = 1;
export const MAX_RUN_RETRY_BASE_DELAY_SEC = 24 * 60 * 60;

/** The exponential factor: 1 disables the growth, 2 doubles every attempt. */
export const DEFAULT_RUN_RETRY_MULTIPLIER = 2;
export const MIN_RUN_RETRY_MULTIPLIER = 1;
export const MAX_RUN_RETRY_MULTIPLIER = 10;

/**
 * 30 min: the ceiling of one wait. Without it a factor of 2 reaches a day by
 * the tenth attempt, which is no longer a retry but a strand.
 */
export const DEFAULT_RUN_RETRY_MAX_DELAY_SEC = 30 * 60;
export const MIN_RUN_RETRY_MAX_DELAY_SEC = 1;
export const MAX_RUN_RETRY_MAX_DELAY_SEC = 24 * 60 * 60;

/**
 * 0 % by default: the delays of the retry paths were deterministic, and a
 * deployment that never saw a herd should not start seeing one. A symmetric
 * ±N % spread is what an operator turns on when many issues fail together.
 */
export const DEFAULT_RUN_RETRY_JITTER_PERCENT = 0;
export const MAX_RUN_RETRY_JITTER_PERCENT = 50;

export interface RunRetryPolicySettings {
  /** Master switch: off keeps every caller on its pre-policy behaviour. */
  enabled: boolean;
  /** Attempt ceiling of a failure the classifier calls transient. */
  maxAttempts: number;
  /** Attempt ceiling of a failure the classifier cannot name. */
  unknownMaxAttempts: number;
  baseDelayMs: number;
  /** Exponential growth factor: delay = base * multiplier ** (attempt - 1). */
  multiplier: number;
  /** Ceiling of a single delay, applied before the jitter. */
  maxDelayMs: number;
  /** Symmetric spread of the delay: 0.1 is ±10 %. */
  jitterRatio: number;
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return fallback;
  return value;
}

export function readRunRetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RUN_RETRY_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function readRunRetryPolicySettings(
  env: NodeJS.ProcessEnv = process.env,
): RunRetryPolicySettings {
  return {
    enabled: readRunRetryEnabled(env),
    maxAttempts: readInt(
      env,
      RUN_RETRY_MAX_ATTEMPTS_ENV,
      DEFAULT_RUN_RETRY_MAX_ATTEMPTS,
      0,
      MAX_RUN_RETRY_MAX_ATTEMPTS,
    ),
    unknownMaxAttempts: readInt(
      env,
      RUN_RETRY_UNKNOWN_MAX_ATTEMPTS_ENV,
      DEFAULT_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS,
      0,
      MAX_RUN_RETRY_MAX_ATTEMPTS,
    ),
    baseDelayMs:
      readInt(
        env,
        RUN_RETRY_BASE_DELAY_SEC_ENV,
        DEFAULT_RUN_RETRY_BASE_DELAY_SEC,
        MIN_RUN_RETRY_BASE_DELAY_SEC,
        MAX_RUN_RETRY_BASE_DELAY_SEC,
      ) * 1000,
    multiplier: readInt(
      env,
      RUN_RETRY_MULTIPLIER_ENV,
      DEFAULT_RUN_RETRY_MULTIPLIER,
      MIN_RUN_RETRY_MULTIPLIER,
      MAX_RUN_RETRY_MULTIPLIER,
    ),
    maxDelayMs:
      readInt(
        env,
        RUN_RETRY_MAX_DELAY_SEC_ENV,
        DEFAULT_RUN_RETRY_MAX_DELAY_SEC,
        MIN_RUN_RETRY_MAX_DELAY_SEC,
        MAX_RUN_RETRY_MAX_DELAY_SEC,
      ) * 1000,
    jitterRatio:
      readInt(
        env,
        RUN_RETRY_JITTER_PERCENT_ENV,
        DEFAULT_RUN_RETRY_JITTER_PERCENT,
        0,
        MAX_RUN_RETRY_JITTER_PERCENT,
      ) / 100,
  };
}