/**
 * myrmidon(SELF-CHECK-GATE): Policy re-exports and policy-level constants for pre-in_review stop-gate.
 */

export {
  MYRMIDON_SELF_CHECK_REJECT_CODES,
  type MyrmidonSelfCheckRejectCode,
  type MyrmidonDiffStats,
  type MyrmidonCheckStatus,
  type MyrmidonRunCheckResult,
  type SelfCheckGateAdmit,
  type SelfCheckGateReject,
  type SelfCheckGateDecision,
  type SelfCheckGateInput,
  type SelfCheckPolicyOptions,
  type FreshnessOptions,
  SelfCheckGateError,
  admitSelfCheckGate,
  rejectSelfCheckGate,
  isSelfCheckGateAdmitted,
  isMyrmidonDiffEmpty,
  isSameCommitSha,
  isCheckResultStale,
  evaluateSelfCheckGate,
  assertSelfCheckGate,
  MYRMIDON_SELF_CHECK_MESSAGES,
} from "./domain.js";
