// 1.6.6 RUN-RETRY-POLICY: classification + exponential backoff + attempt limit
// of a failed run's automatic retry. Entry point of the module; consumers
// import from here (see docs/myrmidon/SETTINGS.md for the MYRMIDON_RUN_RETRY_*
// variables).

export {
  RUN_RETRY_BASE_DELAY_SEC_ENV,
  RUN_RETRY_ENABLED_ENV,
  RUN_RETRY_JITTER_PERCENT_ENV,
  RUN_RETRY_MAX_ATTEMPTS_ENV,
  RUN_RETRY_MAX_DELAY_SEC_ENV,
  RUN_RETRY_MULTIPLIER_ENV,
  RUN_RETRY_UNKNOWN_MAX_ATTEMPTS_ENV,
  DEFAULT_RUN_RETRY_BASE_DELAY_SEC,
  DEFAULT_RUN_RETRY_JITTER_PERCENT,
  DEFAULT_RUN_RETRY_MAX_ATTEMPTS,
  DEFAULT_RUN_RETRY_MAX_DELAY_SEC,
  DEFAULT_RUN_RETRY_MULTIPLIER,
  DEFAULT_RUN_RETRY_UNKNOWN_MAX_ATTEMPTS,
  MAX_RUN_RETRY_JITTER_PERCENT,
  MAX_RUN_RETRY_MAX_ATTEMPTS,
  MAX_RUN_RETRY_MAX_DELAY_SEC,
  MAX_RUN_RETRY_MULTIPLIER,
  MIN_RUN_RETRY_BASE_DELAY_SEC,
  MIN_RUN_RETRY_MAX_DELAY_SEC,
  MIN_RUN_RETRY_MULTIPLIER,
  readRunRetryEnabled,
  readRunRetryPolicySettings,
  type RunRetryPolicySettings,
} from "./settings.js";

export {
  PERMANENT_RUN_FAILURE_ERROR_CODES,
  PERMANENT_RUN_FAILURE_ERROR_FAMILIES,
  TRANSIENT_RUN_FAILURE_ERROR_CODES,
  TRANSIENT_RUN_FAILURE_ERROR_FAMILIES,
  classifyRunFailureForRetry,
  isRetryableRunFailure,
  type RunFailureClass,
  type RunFailureClassification,
  type RunFailureClassificationReason,
  type RunFailureInput,
} from "./classification.js";

export {
  DEFAULT_RUN_RETRY_POLICY,
  MIN_RUN_RETRY_DELAY_MS,
  computeRunRetryBackoff,
  type ComputeRunRetryBackoffInput,
  type RunRetryBackoff,
} from "./backoff.js";

export {
  describeRunRetrySchedule,
  planRunRetry,
  readRunRetryPolicySnapshot,
  resolveRunRetryMaxAttempts,
  type DescribeRunRetryScheduleInput,
  type PlanRunRetryInput,
  type RunRetryDecision,
  type RunRetryDecisionReason,
  type RunRetryScheduleSnapshot,
} from "./policy.js";