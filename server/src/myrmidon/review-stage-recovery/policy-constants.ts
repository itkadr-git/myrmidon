export const REVIEW_WAKE_STALE_AFTER_MS = 4 * 60 * 1000;
export const REVIEW_WAKE_RETRY_BACKOFF_MS = 10 * 60 * 1000;
export const REVIEW_WAKE_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const REVIEW_WAKE_MAX_ATTEMPTS = 6;
// myrmidon(OPE-11947): an exhausted wake series is escalated once and re-armed
// after this long since its last attempt, so a stage stuck behind an
// unavailable model comes back on its own instead of never.
export const REVIEW_WAKE_REARM_AFTER_MS = 6 * 60 * 60 * 1000;
export const REVIEW_ROUTING_MAX_MOVES_PER_PASS = 20;
export const REVIEW_ROUTING_MAX_WAKES_PER_PASS = 6;
// myrmidon(OPE-12178): the number of new reviewer wakes the non-critical
// review admission may create in one board tick. A wake the tick's quota
// cannot admit is deferred without loss: the green-CI monitor re-fires it on
// a later tick. (OPE-12886 keeps this quota: the 13.11 idle-reviewer incident
// was the review-routing sweep's load gate, not the quota.)
export const REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK = 1;
