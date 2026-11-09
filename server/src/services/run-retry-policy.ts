// 1.7 RETRY-UNIFIED: единый классификатор сбоев прогона (OPE-12226 / OPE-12158)
//
// Выделено из heartbeat.ts:
//   - NON_RETRYABLE_PREFLIGHT_FAILURE_CODES (~1212)
//   - PRE_ADAPTER_SETUP_FAILURE_CODES (~1224)
//   - nonRetryablePreflightFailureCode
//   - retryable-шаблоны сообщений (~1562–1600: spawn-like, sandbox worker unavailable)
//   - parseSandboxProviderPluginNotReadyFailureMessage
//   - isRetryableInteractionContinuationInfrastructureFailure (~1617)
//   - classifyRunFailure(...) -> { retryable, reason, backoffHint }

import { HttpError } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import {
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  ChatControlRecoveryUnresolvedError,
} from "./chat-control-recovery-stop.js";

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";

export const NON_RETRYABLE_PREFLIGHT_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
  "chat_failed_run_retry_not_authorized",
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
]);

// Error codes that mark a pre-dispatch setup failure. The adapter process never
// started, so no agent could post an issue comment. The setup catch writes one
// of these codes when a failure happens before `adapter.execute`.
export const PRE_ADAPTER_SETUP_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "setup_failed",
  CONFIGURATION_INCOMPLETE_FAILURE_CODE,
  WORKSPACE_VALIDATION_FAILURE_CODE,
  ...NON_RETRYABLE_PREFLIGHT_FAILURE_CODES,
]);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function nonRetryablePreflightFailureCode(error: unknown): string | null {
  if (error instanceof ChatControlRecoveryUnresolvedError) {
    return CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE;
  }
  if (
    error instanceof HttpError &&
    error.status === 409 &&
    parseObject(error.details).code === "chat_failed_run_retry_not_authorized"
  ) {
    return "chat_failed_run_retry_not_authorized";
  }
  if (!(error instanceof HttpError) || error.status !== 422) return null;
  const code = readNonEmptyString(parseObject(error.details).code);
  return code && NON_RETRYABLE_PREFLIGHT_FAILURE_CODES.has(code) ? code : null;
}

export function isSpawnLikeFailureMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /failed to start command|spawn\b|\bENOENT\b/i.test(value);
}

// A sandbox provider plugin's worker can be briefly down during its own
// restart window (e.g. a rolling deploy of the plugin worker process). Lease
// acquisition fails immediately in that window, but the condition is
// transient and self-healing, so it must be treated as retryable
// infrastructure rather than a terminal setup failure. See
// resolveSandboxProviderPlugin's "worker_unavailable" message in
// environment-runtime.ts (":808"), e.g. 'Sandbox provider "kubernetes" is
// installed via plugin "acme.kubernetes-sandbox-provider", but its worker is
// not running.'
//
// This is anchored on both "is installed via plugin" and "but its worker is
// not running" so it does not also match plugin-environment-driver.ts's
// unrelated, permanent "provider not installed" message ('Sandbox provider
// "X" is not installed or its plugin worker is not running.'), which
// coincidentally contains the same "worker is not running" substring but
// describes a terminal condition that must not be retried.
export function isSandboxProviderWorkerUnavailableFailureMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /sandbox provider .* is installed via plugin .* but its worker is not running/i.test(
    value,
  );
}

// environment-runtime.ts's resolveSandboxProviderPlugin "not_ready" message,
// e.g. 'Sandbox provider "kubernetes" is installed via plugin
// "acme.kubernetes-sandbox-provider", but that plugin is currently error.'
// The plugin row exists but its status is `error` (a failed activation),
// `disabled` (an operator switched it off) or `upgrade_pending`. Unlike the
// worker restart window above, nothing on the run path ever changes that
// status: only an operator enabling the plugin, or a server boot that
// re-activates a bundled plugin, does. Re-running the agent produces the
// identical failure every time, so the setup catch classifies it as
// `configuration_incomplete` (routed to a human owner) instead of a retryable
// `setup_failed` that the scheduler would keep re-dispatching.
export const SANDBOX_PROVIDER_PLUGIN_NOT_READY_RE =
  /sandbox provider "([^"]*)" is installed via plugin "([^"]*)", but that plugin is currently (error|disabled|upgrade_pending)\b/i;

export function parseSandboxProviderPluginNotReadyFailureMessage(
  value: unknown,
): { provider: string; pluginKey: string; pluginStatus: string } | null {
  if (typeof value !== "string") return null;
  const match = SANDBOX_PROVIDER_PLUGIN_NOT_READY_RE.exec(value);
  if (!match) return null;
  return {
    provider: match[1] ?? "",
    pluginKey: match[2] ?? "",
    pluginStatus: (match[3] ?? "").toLowerCase(),
  };
}

export interface RunInfrastructureFailureInput {
  error?: unknown;
  errorCode?: unknown;
  resultJson?: unknown;
}

export function isRetryableInteractionContinuationInfrastructureFailure(
  run: RunInfrastructureFailureInput,
): boolean {
  const code = typeof run.errorCode === "string" ? run.errorCode : null;
  if (
    code === WORKSPACE_VALIDATION_FAILURE_CODE ||
    code === "process_lost"
  ) {
    return true;
  }

  if (code !== "adapter_failed" && code !== "setup_failed") {
    return false;
  }

  const resultJson = parseObject(run.resultJson);
  return (
    isSpawnLikeFailureMessage(run.error) ||
    isSpawnLikeFailureMessage(resultJson.errorMessage) ||
    isSpawnLikeFailureMessage(resultJson.message) ||
    isSandboxProviderWorkerUnavailableFailureMessage(run.error) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.errorMessage) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultJson.message)
  );
}

export interface RunFailureClassificationInput {
  errorCode?: string | null;
  errorFamily?: string | null;
  errorMessage?: string | null;
  error?: unknown;
  resultJson?: unknown;
  runtimeMode?: string | null;
  phase?: string | null;
}

export interface RunFailureClassificationResult {
  retryable: boolean;
  reason: string;
  backoffHint: number | null;
}

/**
 * Unified classifier for run failures across heartbeat preflight, interaction continuation,
 * adapter errors, and native-runtime finalizations.
 */
export function classifyRunFailure(
  input: RunFailureClassificationInput,
): RunFailureClassificationResult {
  const errorCode = readNonEmptyString(input.errorCode);
  const errorMessage =
    readNonEmptyString(input.errorMessage) ??
    (typeof input.error === "string" ? readNonEmptyString(input.error) : null);
  const resultJson = parseObject(input.resultJson);
  const resultMessage =
    readNonEmptyString(resultJson.errorMessage) ??
    readNonEmptyString(resultJson.message);

  // Non-retryable preflight failure codes are definitive: they were terminal
  // regardless of any accompanying message, so they keep top priority.
  if (errorCode && NON_RETRYABLE_PREFLIGHT_FAILURE_CODES.has(errorCode)) {
    return {
      retryable: false,
      reason: `preflight_non_retryable:${errorCode}`,
      backoffHint: null,
    };
  }

  // A plugin in a terminal non-ready state cannot recover by retrying the run.
  if (errorMessage && parseSandboxProviderPluginNotReadyFailureMessage(errorMessage)) {
    return {
      retryable: false,
      reason: "sandbox_provider_plugin_not_ready",
      backoffHint: null,
    };
  }

  // Native finalization persists this phase when the provider session can be
  // resumed. Preserve that durable retry classification independently of the
  // adapter error code that accompanied the failed attempt.
  if (input.phase === "retryable_failure") {
    return {
      retryable: true,
      reason: "native_retryable_failure_phase",
      backoffHint: 30_000,
    };
  }

  // These transient infrastructure messages were historically retryable even
  // when no normalized error code was available to the caller.
  if (
    isSpawnLikeFailureMessage(errorMessage) ||
    isSpawnLikeFailureMessage(resultMessage)
  ) {
    return {
      retryable: true,
      reason: "spawn_like_transient_failure",
      backoffHint: 30_000,
    };
  }
  if (
    isSandboxProviderWorkerUnavailableFailureMessage(errorMessage) ||
    isSandboxProviderWorkerUnavailableFailureMessage(resultMessage)
  ) {
    return {
      retryable: true,
      reason: "sandbox_provider_worker_unavailable",
      backoffHint: 30_000,
    };
  }

  // Pre-adapter setup failure codes (e.g. configuration_incomplete, workspace_validation_failed, setup_failed)
  if (errorCode && PRE_ADAPTER_SETUP_FAILURE_CODES.has(errorCode)) {
    // If it's a spawn-like failure or sandbox worker unavailable in setup, it is retryable infra
    if (
      errorCode !== WORKSPACE_VALIDATION_FAILURE_CODE &&
      isRetryableInteractionContinuationInfrastructureFailure({
        error: input.error,
        errorCode,
        resultJson: input.resultJson,
      })
    ) {
      return {
        retryable: true,
        reason: "infra_setup_transient_failure",
        backoffHint: 30_000,
      };
    }

    return {
      retryable: false,
      reason: `pre_adapter_setup_failure:${errorCode}`,
      backoffHint: null,
    };
  }

  // Generic process_lost
  if (errorCode === "process_lost") {
    return {
      retryable: true,
      reason: "process_lost",
      backoffHint: 30_000,
    };
  }

  // Infrastructure interaction continuation failures
  if (
    isRetryableInteractionContinuationInfrastructureFailure({
      error: input.error,
      errorCode,
      resultJson: input.resultJson,
    })
  ) {
    return {
      retryable: true,
      reason: "interaction_continuation_infra_failure",
      backoffHint: 30_000,
    };
  }

  return {
    retryable: false,
    reason: errorCode ? `unclassified_error_code:${errorCode}` : "unclassified_failure",
    backoffHint: null,
  };
}
