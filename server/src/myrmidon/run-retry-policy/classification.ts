// Error classification of a failed run: transient or permanent (1.6.6
// RUN-RETRY-POLICY).
//
// The board used to answer "should this failure be retried?" in several places
// at once — a set of codes in the continuation recovery, another set in the
// wake queue, an `errorFamily` check in the heartbeat, a message regex in the
// adapter failure path. This module is the one taxonomy: a run's failure is
// transient (retryable), permanent (retrying repeats the same failure) or
// unknown (the board cannot name it and spends the single default attempt).
//
// Two rules keep the verdict stable and fail closed:
//
//   * permanent evidence wins. An adapter that marks a family explicitly
//     (`permanent_config_error`, `model_refusal`, a rotated refresh token)
//     knows more than a code lookup, and a misclassified transient failure
//     costs one wasted attempt while a misclassified permanent one costs a
//     retry storm — so the explicit permanent verdict is checked first.
//   * only structured evidence counts. The classifier reads `errorCode` and
//     `errorFamily`, never free-form error text: the text-based verdicts stay
//     where the parsing lives (`classifyAdapterFailureForRecovery`), and a
//     message that merely mentions a quota cannot reclassify a run here.
//
// The code sets are the ones the continuation recovery carried, moved here so
// that both the recovery sweep and the heartbeat answer from one list.

export type RunFailureClass = "transient" | "permanent" | "unknown";

export type RunFailureClassificationReason =
  | "permanent_error_family"
  | "permanent_error_code"
  | "transient_error_family"
  | "transient_error_code"
  | "unknown_error_code"
  | "missing_error_code";

/**
 * A retry is worth its cost: the failure is a collision with infrastructure
 * that is expected to come back (an upstream 5xx, a quota window, a timeout,
 * a crashed harness), not a property of the work itself.
 */
export const TRANSIENT_RUN_FAILURE_ERROR_CODES: ReadonlySet<string> = new Set([
  "adapter_failed",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "timeout",
]);

/**
 * Retrying repeats the same failure. The task has to be repaired (its agent,
 * its budget, its workspace, its credentials) before another run can succeed,
 * so the retry would only burn an attempt and delay the operator's view of the
 * problem. `setup_failed` is the fail-closed fallback for exceptions raised
 * before an adapter process starts; the workspace-git-scan codes own their own
 * durable budget and the low-trust codes are boundary violations, not weather.
 */
export const PERMANENT_RUN_FAILURE_ERROR_CODES: ReadonlySet<string> = new Set([
  "adapter_engine_unavailable",
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
  "setup_failed",
  "workspace_git_scan_timeout",
  "workspace_git_scan_saturated",
  "workspace_git_scan_cancelled",
  "workspace_git_scan_output_limit",
  "workspace_git_scan_failed",
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
]);

/**
 * Adapter execution error families (`AdapterExecutionErrorFamily`) that are
 * weather: the same call a minute later can succeed.
 */
export const TRANSIENT_RUN_FAILURE_ERROR_FAMILIES: ReadonlySet<string> =
  new Set(["transient_upstream", "provider_quota"]);

/**
 * Families that are a property of the configuration, not of the moment. A
 * refusal, an unusable model/key pair or a refresh token that has already been
 * rotated answers identically on every attempt.
 *
 * `refresh_token_expired` is deliberately absent: an expired token is repaired
 * by the adapter's own refresh path inside a run, and the board has no evidence
 * yet about what a *retry* of the run does with it — so it keeps the historical
 * unclassified treatment (one attempt) instead of a verdict invented here.
 */
export const PERMANENT_RUN_FAILURE_ERROR_FAMILIES: ReadonlySet<string> =
  new Set([
    "permanent_config_error",
    "model_refusal",
    "refresh_token_reused",
    "refresh_token_invalidated",
  ]);

export interface RunFailureInput {
  /** `heartbeat_runs.error_code` of the failed run. */
  errorCode?: string | null;
  /** `errorFamily` of the adapter execution result, when the run carries one. */
  errorFamily?: string | null;
}

export interface RunFailureClassification {
  classification: RunFailureClass;
  errorCode: string | null;
  errorFamily: string | null;
  reason: RunFailureClassificationReason;
}

function readToken(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function classifyRunFailureForRetry(
  input: RunFailureInput,
): RunFailureClassification {
  const errorCode = readToken(input.errorCode);
  const errorFamily = readToken(input.errorFamily);

  if (errorFamily && PERMANENT_RUN_FAILURE_ERROR_FAMILIES.has(errorFamily)) {
    return {
      classification: "permanent",
      errorCode,
      errorFamily,
      reason: "permanent_error_family",
    };
  }
  if (errorCode && PERMANENT_RUN_FAILURE_ERROR_CODES.has(errorCode)) {
    return {
      classification: "permanent",
      errorCode,
      errorFamily,
      reason: "permanent_error_code",
    };
  }
  if (errorFamily && TRANSIENT_RUN_FAILURE_ERROR_FAMILIES.has(errorFamily)) {
    return {
      classification: "transient",
      errorCode,
      errorFamily,
      reason: "transient_error_family",
    };
  }
  if (errorCode && TRANSIENT_RUN_FAILURE_ERROR_CODES.has(errorCode)) {
    return {
      classification: "transient",
      errorCode,
      errorFamily,
      reason: "transient_error_code",
    };
  }
  return {
    classification: "unknown",
    errorCode,
    errorFamily,
    reason: errorCode ? "unknown_error_code" : "missing_error_code",
  };
}

/** Only a transient failure is retried; the other two classes are terminal. */
export function isRetryableRunFailure(
  classification: RunFailureClassification,
): boolean {
  return classification.classification === "transient";
}