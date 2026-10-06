import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  // myrmidon(PERF-DIET-I): the LiteLLM 403 key-permission failure must reach
  // the configuration blocker (blocked issue, no retry) whether it arrives
  // with the new adapter error-family field or only as raw 403 text from a
  // historical run or a different adapter. The gateway code
  // "hermes_gateway_run_failed" is not part of the error-code gate, which is
  // why the branch lives ahead of it.
  it("routes the 403 key-not-allowed text to a configuration blocker", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "hermes_gateway_run_failed",
      error:
        'litellm.BadRequestError: LLM Provider NOT allowed. 403 - {"error": {"message": "key not allowed to access model dashscope-glm-5.3"}}',
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Key Not Allowed To Access Model dashscope-glm-5.3",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("routes a run carrying the permanent_config_error family to a configuration blocker", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "hermes_gateway_run_failed",
      error: "Hermes run failed",
      resultJson: { errorFamily: "permanent_config_error" },
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("leaves the gateway connection-error transient outside the configuration blocker", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "hermes_gateway_run_failed",
      error: "Connection error.",
      resultJson: { errorFamily: "transient_upstream" },
    })).toBeNull();
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Connection error.",
      resultJson: null,
    })).toBeNull();
  });
});
