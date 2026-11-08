export const REVIEW_WAKE_STALE_AFTER_MS = 30 * 60 * 1000;
export const REVIEW_WAKE_RETRY_BACKOFF_MS = 10 * 60 * 1000;
export const REVIEW_WAKE_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const REVIEW_WAKE_MAX_ATTEMPTS = 6;
// myrmidon(OPE-11947): an exhausted wake series is escalated once and re-armed
// after this long since its last attempt, so a stage stuck behind an
// unavailable model comes back on its own instead of never.
export const REVIEW_WAKE_REARM_AFTER_MS = 6 * 60 * 60 * 1000;
export const REVIEW_ROUTING_MAX_MOVES_PER_PASS = 20;
export const REVIEW_ROUTING_MAX_WAKES_PER_PASS = 1;
