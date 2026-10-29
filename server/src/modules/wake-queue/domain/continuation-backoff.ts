/** Default rolling-window continuation budget. Callers may supply a configured budget. */
export const DEFAULT_MAX_EMPTY_CONTINUATIONS_PER_WINDOW = 6;
/** Default rolling-window duration in milliseconds. */
export const DEFAULT_CONTINUATION_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Default maximum delay applied by the continuation scheduler. */
export const DEFAULT_MAX_CONTINUATION_DELAY_MS = DEFAULT_CONTINUATION_WINDOW_MS;

export type ContinuationBackoffInput = {
  recentCount: number;
  windowMs: number;
  maxContinuations?: number;
  maxDelayMs?: number;
};

/**
 * Return an increasing delay based on the recent-event count. At the budget,
 * wait for one full window so the oldest event expires before retrying.
 */
export function nextContinuationDelay({
  recentCount,
  windowMs,
  maxContinuations = DEFAULT_MAX_EMPTY_CONTINUATIONS_PER_WINDOW,
  maxDelayMs = DEFAULT_MAX_CONTINUATION_DELAY_MS,
}: ContinuationBackoffInput): number {
  if (!Number.isFinite(recentCount) || recentCount <= 0) return 0;
  if (
    !Number.isFinite(windowMs) || windowMs <= 0 ||
    !Number.isFinite(maxContinuations) || maxContinuations <= 0 ||
    !Number.isFinite(maxDelayMs) || maxDelayMs <= 0
  ) return 0;

  const count = Math.max(1, Math.floor(recentCount));
  const delay = count >= maxContinuations
    ? windowMs
    : (windowMs / maxContinuations) * count;
  // The window wait is a safety requirement when the budget is exhausted;
  // a scheduler cap must not allow another continuation before a slot expires.
  return count >= maxContinuations ? delay : Math.min(delay, maxDelayMs);
}
