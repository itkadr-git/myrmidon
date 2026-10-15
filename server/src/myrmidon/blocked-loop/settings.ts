// myrmidon(BLOCKED-LOOP): settings of the repeated-return limiter
// (MYRMIDON_BLOCKED_LOOP_MAX_RETURNS). See docs/myrmidon/SETTINGS.md.

export const BLOCKED_LOOP_MAX_RETURNS_ENV = "MYRMIDON_BLOCKED_LOOP_MAX_RETURNS";
export const DEFAULT_BLOCKED_LOOP_MAX_RETURNS = 3;
export const MIN_BLOCKED_LOOP_MAX_RETURNS = 1;
export const MAX_BLOCKED_LOOP_MAX_RETURNS = 50;

/**
 * How many consecutive agent returns to `blocked` (same blocker set, same
 * unblock descriptor) are allowed. Anything that is not an integer in
 * [1, 50] reads as the default.
 */
export function readBlockedLoopMaxReturns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[BLOCKED_LOOP_MAX_RETURNS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_BLOCKED_LOOP_MAX_RETURNS;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_BLOCKED_LOOP_MAX_RETURNS ||
    value > MAX_BLOCKED_LOOP_MAX_RETURNS
  ) {
    return DEFAULT_BLOCKED_LOOP_MAX_RETURNS;
  }
  return value;
}
