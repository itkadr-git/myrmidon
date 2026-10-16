// myrmidon(CORPUS-2.0): retry policy shared by the corpus module's outbound HTTP calls.

export interface RetryPolicy {
  /** Total number of attempts, including the first one. */
  readonly attempts: number;
  /** Delay before the second attempt; it doubles for every further attempt. */
  readonly baseDelayMs: number;
  /** Upper bound for a single delay. */
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

export interface RetryContext {
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly random: () => number;
}

export function defaultRetryContext(): RetryContext {
  return {
    sleep: (milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
    random: Math.random,
  };
}

export function assertRetryPolicy(policy: RetryPolicy): RetryPolicy {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new RangeError("retry policy needs at least one attempt");
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new RangeError("retry policy base delay must be a non-negative number");
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError("retry policy max delay must not be smaller than the base delay");
  }
  return policy;
}

/** Delay before `attempt` (1-based, the attempt that failed). Half fixed, half jittered. */
export function retryDelayMs(policy: RetryPolicy, attempt: number, random: () => number): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + random() * (cap / 2));
}

/**
 * Runs `run` until it succeeds, until the error is not retryable, or until the policy runs
 * out of attempts. The attempt number is passed to `run`, so the error a caller throws can
 * carry it. Errors that are not retryable are rethrown unchanged.
 */
export async function runWithRetries<T>(
  policy: RetryPolicy,
  context: RetryContext,
  run: (attempt: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  const effective = assertRetryPolicy(policy);
  let firstError: unknown;
  for (let attempt = 1; attempt <= effective.attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt === 1) firstError = error;
      if (!isRetryable(error) || attempt === effective.attempts) throw error;
      await context.sleep(retryDelayMs(effective, attempt, context.random));
    }
  }
  throw firstError;
}

/** Reads a `retryable` flag off an unknown error without importing the throwing module. */
export function isRetryableFlagged(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { retryable?: unknown }).retryable === true;
}