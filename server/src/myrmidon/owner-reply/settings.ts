// myrmidon(1.6.5-F21-B): settings of the owner-card TTL sweep
// (MYRMIDON_OWNER_CARD_*). See docs/myrmidon/SETTINGS.md.
//
// An owner request_confirmation card the owner leaves unanswered for longer
// than the TTL is closed by the sweep: either resolved by the card's
// recommended option (silence-means-recommended mode) or expired. Unlike the
// stale-block watchdog this sweep ships ENABLED — it closes a defect class
// (owner cards that can never be answered stay pending forever), so an unset
// env keeps the default 72 h TTL. The interval is a deployment value.

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

export const OWNER_CARD_TTL_MS_ENV = "MYRMIDON_OWNER_CARD_TTL_MS";
export const OWNER_CARD_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_OWNER_CARD_SWEEP_INTERVAL_SEC";
export const OWNER_CARD_SWEEP_WAKE_BUDGET_ENV = "MYRMIDON_OWNER_CARD_SWEEP_WAKE_BUDGET";

/** 72 hours: the default TTL the ticket names. */
export const DEFAULT_OWNER_CARD_TTL_MS = 72 * 60 * 60 * 1000;
export const MIN_OWNER_CARD_TTL_MS = 60 * 1000;
export const MAX_OWNER_CARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 5 minutes between two sweep passes, same cadence as the stale-block watchdog. */
export const DEFAULT_OWNER_CARD_SWEEP_INTERVAL_SEC = 300;
export const MIN_OWNER_CARD_SWEEP_INTERVAL_SEC = 15;
export const MAX_OWNER_CARD_SWEEP_INTERVAL_SEC = 24 * 60 * 60;

/** The sweep inspects at most this many pending owner cards per pass. */
export const DEFAULT_OWNER_CARD_SWEEP_PAGE_SIZE = 50;

/**
 * At most this many author wakes per pass. The first pass after an upgrade can
 * meet a backlog of already-expired cards; the budget keeps that pass from
 * storming every author at once — the rest is woken on the following passes
 * (the card itself is closed in the same pass, the wake is the notification).
 */
export const DEFAULT_OWNER_CARD_SWEEP_WAKE_BUDGET = 20;
export const MAX_OWNER_CARD_SWEEP_WAKE_BUDGET = 200;

/** A pending owner card older than this is counted as stale in the attention summary. */
export const OWNER_CARD_STALE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface OwnerCardTtlSettings {
  ttlMs: number;
  /** Minimum spacing between two sweep passes. */
  intervalMs: number;
  /** Ceiling on pending owner cards inspected in one pass. */
  pageSize: number;
  /** Ceiling on author wakes sent in one pass. */
  wakeBudget: number;
}

export function readOwnerCardTtlSettings(env: NodeJS.ProcessEnv = process.env): OwnerCardTtlSettings {
  return {
    ttlMs: readInt(env, OWNER_CARD_TTL_MS_ENV, DEFAULT_OWNER_CARD_TTL_MS, MIN_OWNER_CARD_TTL_MS, MAX_OWNER_CARD_TTL_MS),
    intervalMs:
      readInt(
        env,
        OWNER_CARD_SWEEP_INTERVAL_SEC_ENV,
        DEFAULT_OWNER_CARD_SWEEP_INTERVAL_SEC,
        MIN_OWNER_CARD_SWEEP_INTERVAL_SEC,
        MAX_OWNER_CARD_SWEEP_INTERVAL_SEC,
      ) * 1000,
    pageSize: DEFAULT_OWNER_CARD_SWEEP_PAGE_SIZE,
    wakeBudget: readInt(
      env,
      OWNER_CARD_SWEEP_WAKE_BUDGET_ENV,
      DEFAULT_OWNER_CARD_SWEEP_WAKE_BUDGET,
      1,
      MAX_OWNER_CARD_SWEEP_WAKE_BUDGET,
    ),
  };
}
