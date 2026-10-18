// myrmidon(BLOCKED-LOOP): entry point of the repeated-return limiter.
// One import and one guard block in routes/issues.ts (CONVENTIONS.md §12).

export {
  blockedLoopMessage,
  blockerSetKeyOf,
  descriptorKeyOf,
  judgeBlockedLoop,
  type BlockedLoopAttempt,
  type BlockedLoopDecision,
  type BlockedLoopEvent,
  type BlockedLoopEventKind,
} from "./policy.js";
export {
  BLOCKED_LOOP_SIGNATURE_KEY,
  loadBlockedLoopEvents,
  toBlockedLoopEvent,
  type BlockedLoopSignature,
} from "./history.js";
export {
  BLOCKED_LOOP_MAX_RETURNS_ENV,
  DEFAULT_BLOCKED_LOOP_MAX_RETURNS,
  readBlockedLoopMaxReturns,
} from "./settings.js";
