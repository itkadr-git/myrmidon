// 1.7 RETRY-UNIFIED: golden table for the unified run-failure classifier
// (OPE-12226 / OPE-12158). The code sets and message detectors moved verbatim
// from heartbeat.ts; this table pins the pre-move classification of every
// transferred code and pattern (the sets and regexes below are copied from
// heartbeat.ts as they lived before the move) so that an accidental
// retryable <-> non-retryable flip fails here.
import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  ChatControlRecoveryUnresolvedError,
} from "./chat-control-recovery-stop.js";
import {
  NON_RETRYABLE_PREFLIGHT_FAILURE_CODES,
  PRE_ADAPTER_SETUP_FAILURE_CODES,
  classifyRunFailure,
  isRetryableInteractionContinuationInfrastructureFailure,
  isSandboxProviderWorkerUnavailableFailureMessage,
  isSpawnLikeFailureMessage,
  nonRetryablePreflightFailureCode,
  parseSandboxProviderPluginNotReadyFailureMessage,
} from "./run-retry-policy.js";

// --- Golden copies of the pre-move sets (heartbeat.ts ~1212/~1224) ----------
const GOLDEN_NON_RETRYABLE_PREFLIGHT_FAILURE_CODES = [
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
  "chat_failed_run_retry_not_authorized",
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
] as const;

const GOLDEN_PRE_ADAPTER_SETUP_FAILURE_CODES = [
  "setup_failed",
  "configuration_incomplete",
  "workspace_validation_failed",
  ...GOLDEN_NON_RETRYABLE_PREFLIGHT_FAILURE_CODES,
] as const;

// --- Golden copies of the pre-move message regexes (heartbeat.ts ~1570-1600)
const GOLDEN_SPAWN_LIKE_RE = /failed to start command|spawn\b|\bENOENT\b/i;
const GOLDEN_SANDBOX_WORKER_UNAVAILABLE_RE =
  /sandbox provider .* is installed via plugin .* but its worker is not running/i;
const GOLDEN_SANDBOX_PLUGIN_NOT_READY_RE =
  /sandbox provider "([^"]*)" is installed via plugin "([^"]*)", but that plugin is currently (error|disabled|upgrade_pending)\b/i;

const sorted = (values: Iterable<string>) => [...values].sort();

describe("run-retry-policy sets match the pre-move heartbeat sets", () => {
  it("NON_RETRYABLE_PREFLIGHT_FAILURE_CODES is unchanged", () => {
    expect(sorted(NON_RETRYABLE_PREFLIGHT_FAILURE_CODES)).toEqual(
      sorted(GOLDEN_NON_RETRYABLE_PREFLIGHT_FAILURE_CODES),
    );
  });

  it("PRE_ADAPTER_SETUP_FAILURE_CODES is unchanged", () => {
    expect(sorted(PRE_ADAPTER_SETUP_FAILURE_CODES)).toEqual(
      sorted(GOLDEN_PRE_ADAPTER_SETUP_FAILURE_CODES),
    );
  });
});

describe("spawn-like detector matches the pre-move regex", () => {
  it.each([
    ["failed to start command 'pnpm test'", true],
    ["spawn ENOENT", true],
    ["adapter spawn attempt failed", true],
    ["fatal error: ENOENT: no such file or directory", true],
    ["spawned process exited cleanly", false],
    ["ENOENTX is not a code", false],
    ["model overloaded, try again", false],
  ])("%j -> %j", (message, expected) => {
    expect(isSpawnLikeFailureMessage(message)).toBe(
      GOLDEN_SPAWN_LIKE_RE.test(message),
    );
    expect(isSpawnLikeFailureMessage(message)).toBe(expected);
  });

  it("refuses non-string input like the pre-move helper", () => {
    for (const value of [null, undefined, 42, {}, Buffer.from("spawn")]) {
      expect(isSpawnLikeFailureMessage(value)).toBe(false);
    }
  });
});

describe("sandbox provider worker-unavailable detector matches the pre-move regex", () => {
  const workerDown =
    'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but its worker is not running.';
  // The permanent "not installed" message shares the "worker is not running"
  // substring but must stay terminal (non-retryable), exactly as before.
  const notInstalled =
    'Sandbox provider "X" is not installed or its plugin worker is not running.';
  const pluginError =
    'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but that plugin is currently error.';

  it.each([
    [workerDown, true],
    [notInstalled, false],
    [pluginError, false],
  ])("%j -> %j", (message, expected) => {
    expect(isSandboxProviderWorkerUnavailableFailureMessage(message)).toBe(
      GOLDEN_SANDBOX_WORKER_UNAVAILABLE_RE.test(message),
    );
    expect(isSandboxProviderWorkerUnavailableFailureMessage(message)).toBe(
      expected,
    );
  });
});

describe("sandbox provider plugin-not-ready parser matches the pre-move regex", () => {
  it.each([
    [
      'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but that plugin is currently error.',
      { provider: "kubernetes", pluginKey: "acme.kubernetes-sandbox-provider", pluginStatus: "error" },
    ],
    [
      'Sandbox provider "daytona" is installed via plugin "corp.daytona", but that plugin is currently disabled.',
      { provider: "daytona", pluginKey: "corp.daytona", pluginStatus: "disabled" },
    ],
    [
      'Sandbox provider "gvisor" is installed via plugin "corp.gvisor", but that plugin is currently upgrade_pending.',
      { provider: "gvisor", pluginKey: "corp.gvisor", pluginStatus: "upgrade_pending" },
    ],
  ])("%s", (message, expected) => {
    expect(parseSandboxProviderPluginNotReadyFailureMessage(message)).toEqual(
      expected,
    );
    const match = GOLDEN_SANDBOX_PLUGIN_NOT_READY_RE.exec(message);
    expect(match).not.toBeNull();
    expect(parseSandboxProviderPluginNotReadyFailureMessage(message)).toEqual({
      provider: match?.[1] ?? "",
      pluginKey: match?.[2] ?? "",
      pluginStatus: (match?.[3] ?? "").toLowerCase(),
    });
  });

  it.each([
    ["Sandbox provider \"kubernetes\" is installed via plugin \"p\", but that plugin is currently erroring.", "status word does not terminate"],
    ["Sandbox provider \"kubernetes\" is installed via plugin \"p\", but its worker is not running.", "worker-down, not a plugin status"],
    ["Sandbox provider \"X\" is not installed or its plugin worker is not running.", "terminal not-installed message"],
    ["totally unrelated", "unrelated text"],
  ])("refuses: %s (%s)", (message) => {
    expect(parseSandboxProviderPluginNotReadyFailureMessage(message)).toBeNull();
    expect(GOLDEN_SANDBOX_PLUGIN_NOT_READY_RE.exec(message)).toBeNull();
  });

  it("refuses non-string input like the pre-move parser", () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(parseSandboxProviderPluginNotReadyFailureMessage(value)).toBeNull();
    }
  });
});

describe("nonRetryablePreflightFailureCode classifies like the pre-move helper", () => {
  it.each(GOLDEN_NON_RETRYABLE_PREFLIGHT_FAILURE_CODES)(
    "HttpError 422 with %j -> the code itself",
    (code) => {
      const error = new HttpError(422, "preflight failed", { code });
      expect(nonRetryablePreflightFailureCode(error)).toBe(code);
    },
  );

  it("HttpError 409 chat_failed_run_retry_not_authorized -> the code", () => {
    const error = new HttpError(409, "retry not authorized", {
      code: "chat_failed_run_retry_not_authorized",
    });
    expect(nonRetryablePreflightFailureCode(error)).toBe(
      "chat_failed_run_retry_not_authorized",
    );
  });

  it("ChatControlRecoveryUnresolvedError -> the unresolved code", () => {
    expect(nonRetryablePreflightFailureCode(new ChatControlRecoveryUnresolvedError())).toBe(
      CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
    );
  });

  it.each([
    ["HttpError 422 with an unknown code", new HttpError(422, "boom", { code: "not_in_the_set" })],
    ["HttpError 422 without a code", new HttpError(422, "boom")],
    ["HttpError 500", new HttpError(500, "boom")],
    ["plain Error", new Error("boom")],
    ["non-error", "boom"],
  ])("refuses: %s", (_name, error) => {
    expect(nonRetryablePreflightFailureCode(error)).toBeNull();
  });
});

describe("isRetryableInteractionContinuationInfrastructureFailure keeps the pre-move predicate", () => {
  it.each([
    [{ errorCode: "workspace_validation_failed" }, true],
    [{ errorCode: "process_lost" }, true],
    [{ errorCode: "adapter_failed", error: "spawn ENOENT" }, true],
    [{ errorCode: "setup_failed", error: "failed to start command 'pnpm'" }, true],
    [
      {
        errorCode: "adapter_failed",
        resultJson: {
          message:
            'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but its worker is not running.',
        },
      },
      true,
    ],
    [{ errorCode: "adapter_failed", error: "model overloaded" }, false],
    [{ errorCode: "setup_failed", resultJson: { message: "workspace missing" } }, false],
    [{ errorCode: "some_other_code" }, false],
    [{}, false],
  ])("%j -> %j", (run, expected) => {
    expect(isRetryableInteractionContinuationInfrastructureFailure(run)).toBe(expected);
  });
});

describe("classifyRunFailure golden table", () => {
  it.each(GOLDEN_NON_RETRYABLE_PREFLIGHT_FAILURE_CODES)(
    "preflight code %j stays non-retryable",
    (code) => {
      expect(classifyRunFailure({ errorCode: code })).toEqual({
        retryable: false,
        reason: `preflight_non_retryable:${code}`,
        backoffHint: null,
      });
    },
  );

  it.each(["setup_failed", "configuration_incomplete", "workspace_validation_failed"])(
    "pre-adapter setup code %j stays non-retryable",
    (code) => {
      expect(classifyRunFailure({ errorCode: code })).toEqual({
        retryable: false,
        reason: `pre_adapter_setup_failure:${code}`,
        backoffHint: null,
      });
    },
  );

  it("spawn-like setup failure is retryable infrastructure", () => {
    expect(
      classifyRunFailure({
        errorCode: "setup_failed",
        error: "spawn ENOENT",
      }),
    ).toEqual({
      retryable: true,
      reason: "infra_setup_transient_failure",
      backoffHint: 30_000,
    });
  });

  it.each([
    [
      {
        errorCode: "adapter_failed",
        error: 'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but its worker is not running.',
      },
      "interaction_continuation_infra_failure",
    ],
    [{ errorCode: "process_lost" }, "process_lost"],
    [{ errorMessage: "spawn ENOENT" }, "spawn_like_transient_failure"],
    [{ phase: "retryable_failure" }, "native_retryable_failure_phase"],
    [
      {
        runtimeMode: "native",
        phase: "retryable_failure",
        errorCode: "adapter_failed",
        error: "boom",
      },
      "native_retryable_failure_phase",
    ],
    [
      {
        errorMessage:
          'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but its worker is not running.',
      },
      "sandbox_provider_worker_unavailable",
    ],
  ])("%j -> retryable (%s)", (input, reason) => {
    expect(classifyRunFailure(input)).toMatchObject({
      retryable: true,
      reason,
      backoffHint: 30_000,
    });
  });

  it.each([
    [
      {
        errorMessage:
          'Sandbox provider "kubernetes" is installed via plugin "acme.kubernetes-sandbox-provider", but that plugin is currently disabled.',
      },
      "sandbox_provider_plugin_not_ready",
    ],
    [{ errorCode: "brand_new_code" }, "unclassified_error_code:brand_new_code"],
    [{}, "unclassified_failure"],
  ])("%j -> non-retryable (%s)", (input, reason) => {
    expect(classifyRunFailure(input)).toEqual({
      retryable: false,
      reason,
      backoffHint: null,
    });
  });
});
