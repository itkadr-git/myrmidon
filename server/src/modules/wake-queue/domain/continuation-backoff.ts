/** Maximum number of empty continuations allowed in a three-hour window. */
export const MAX_EMPTY_CONTINUATIONS_PER_WINDOW = 30;
/** Three hours, in milliseconds. */
export const CONTINUATION_WINDOW_MS = 3 * 60 * 60 * 1000;
/** Minimum average spacing needed to keep the window at or below the cap. */
export const MAX_CONTINUATION_DELAY_MS =
  CONTINUATION_WINDOW_MS / MAX_EMPTY_CONTINUATIONS_PER_WINDOW;

export type ContinuationBackoffInput = {
  recentCount: number;
  windowMs: number;
};

/** Return a deterministic, monotone delay for the next continuation. */
export function nextContinuationDelay({
  recentCount,
  windowMs,
}: ContinuationBackoffInput): number {
  if (!Number.isFinite(recentCount) || recentCount <= 0) return 0;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;

  const count = Math.min(Math.floor(recentCount), MAX_EMPTY_CONTINUATIONS_PER_WINDOW);
  return Math.min(
    MAX_CONTINUATION_DELAY_MS,
    (count / MAX_EMPTY_CONTINUATIONS_PER_WINDOW) * windowMs,
  );
}