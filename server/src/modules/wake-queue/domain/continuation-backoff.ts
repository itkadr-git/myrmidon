/** Maximum number of empty continuations allowed in a three-hour window. */
export const MAX_EMPTY_CONTINUATIONS_PER_WINDOW = 6;
/** Three hours, in milliseconds. */
export const CONTINUATION_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Delay at the event cap; the first event remains immediate. */
export const MAX_CONTINUATION_DELAY_MS =
  CONTINUATION_WINDOW_MS / MAX_EMPTY_CONTINUATIONS_PER_WINDOW;

export type ContinuationBackoffInput = {
  recentCount: number;
  windowMs: number;
};

/**
 * Return a monotone delay that spaces events across the rolling-window budget.
 * The caller applies this delay before creating a continuation.
 */
export function nextContinuationDelay({
  recentCount,
  windowMs,
}: ContinuationBackoffInput): number {
  if (!Number.isFinite(recentCount) || recentCount <= 0) return 0;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;

  return Math.min(
    MAX_CONTINUATION_DELAY_MS,
    Math.min(windowMs, CONTINUATION_WINDOW_MS) / MAX_EMPTY_CONTINUATIONS_PER_WINDOW,
  );
}
