import { describe, expect, it } from "vitest";
import {
  PERMANENT_RUN_FAILURE_ERROR_CODES,
  PERMANENT_RUN_FAILURE_ERROR_FAMILIES,
  TRANSIENT_RUN_FAILURE_ERROR_CODES,
  TRANSIENT_RUN_FAILURE_ERROR_FAMILIES,
  classifyRunFailureForRetry,
  isPermanentAgentFailure,
  isRetryableRunFailure,
  isTransientFailure,
} from "./classification.js";

describe("run retry policy: failure classification", () => {
  it("calls a known transient failure retryable", () => {
    expect(
      [...TRANSIENT_RUN_FAILURE_ERROR_CODES].map((errorCode) =>
        classifyRunFailureForRetry({ errorCode }),
      ),
    ).toEqual(
      [...TRANSIENT_RUN_FAILURE_ERROR_CODES].map((errorCode) => ({
        classification: "transient",
        errorCode,
        errorFamily: null,
        reason: "transient_error_code",
      })),
    );
  });

  it("calls a known permanent failure terminal", () => {
    for (const errorCode of PERMANENT_RUN_FAILURE_ERROR_CODES) {
      const verdict = classifyRunFailureForRetry({ errorCode });
      expect(verdict.classification).toBe("permanent");
      expect(verdict.reason).toBe("permanent_error_code");
      expect(isRetryableRunFailure(verdict)).toBe(false);
    }
  });

  it("classifies by the adapter error family as well as by the code", () => {
    for (const errorFamily of TRANSIENT_RUN_FAILURE_ERROR_FAMILIES) {
      const verdict = classifyRunFailureForRetry({ errorFamily });
      expect(verdict.classification).toBe("transient");
      expect(verdict.reason).toBe("transient_error_family");
    }
    for (const errorFamily of PERMANENT_RUN_FAILURE_ERROR_FAMILIES) {
      const verdict = classifyRunFailureForRetry({ errorFamily });
      expect(verdict.classification).toBe("permanent");
      expect(verdict.reason).toBe("permanent_error_family");
    }
  });

  it("lets explicit permanent evidence win over a transient code", () => {
    // A gateway run persists `hermes_gateway_run_failed` with the family the
    // adapter attached: the family knows more than the code lookup, and a
    // permanent failure scheduled as transient burns attempts.
    expect(
      classifyRunFailureForRetry({
        errorCode: "adapter_failed",
        errorFamily: "permanent_config_error",
      }),
    ).toMatchObject({ classification: "permanent", reason: "permanent_error_family" });
    expect(
      classifyRunFailureForRetry({
        errorCode: "provider_quota",
        errorFamily: "model_refusal",
      }).classification,
    ).toBe("permanent");
  });

  it("keeps one taxonomy: no code is transient and permanent at once", () => {
    const both = [...TRANSIENT_RUN_FAILURE_ERROR_CODES].filter((code) =>
      PERMANENT_RUN_FAILURE_ERROR_CODES.has(code),
    );
    expect(both).toEqual([]);
    const familiesBoth = [...TRANSIENT_RUN_FAILURE_ERROR_FAMILIES].filter(
      (family) => PERMANENT_RUN_FAILURE_ERROR_FAMILIES.has(family),
    );
    expect(familiesBoth).toEqual([]);
  });

  it("calls an unnamed failure unknown, not retryable", () => {
    expect(
      classifyRunFailureForRetry({ errorCode: "something_new_entirely" }),
    ).toEqual({
      classification: "unknown",
      errorCode: "something_new_entirely",
      errorFamily: null,
      reason: "unknown_error_code",
    });
    // An expired refresh token has no retry evidence yet: it keeps the
    // historical unclassified treatment instead of an invented verdict.
    expect(
      classifyRunFailureForRetry({ errorFamily: "refresh_token_expired" })
        .classification,
    ).toBe("unknown");
  });

  it("treats a run without any failure evidence as unknown", () => {
    for (const input of [
      {},
      { errorCode: null, errorFamily: null },
      { errorCode: "   ", errorFamily: "" },
    ]) {
      const verdict = classifyRunFailureForRetry(input);
      expect(verdict.classification).toBe("unknown");
      expect(verdict.reason).toBe("missing_error_code");
      expect(verdict.errorCode).toBeNull();
      expect(verdict.errorFamily).toBeNull();
    }
  });

  it("trims the persisted tokens before the lookup", () => {
    expect(
      classifyRunFailureForRetry({
        errorCode: "  timeout  ",
        errorFamily: " transient_upstream ",
      }),
    ).toEqual({
      classification: "transient",
      errorCode: "timeout",
      errorFamily: "transient_upstream",
      reason: "transient_error_family",
    });
  });

  it("retries only the transient class", () => {
    expect(isRetryableRunFailure(classifyRunFailureForRetry({ errorCode: "timeout" }))).toBe(
      true,
    );
    expect(
      isRetryableRunFailure(classifyRunFailureForRetry({ errorCode: "budget_exhausted" })),
    ).toBe(false);
    expect(isRetryableRunFailure(classifyRunFailureForRetry({}))).toBe(false);
  });

  it("classifies transient error messages when errorCode is generic (e.g. setup_failed, adapter_failed)", () => {
    expect(
      classifyRunFailureForRetry({
        errorCode: "setup_failed",
        errorMessage: "Error: continuation_source_context_missing",
      }),
    ).toMatchObject({
      classification: "transient",
      reason: "transient_error_message",
    });
    expect(
      classifyRunFailureForRetry({
        errorCode: "adapter_failed",
        errorMessage: "stream was interrupted",
      }),
    ).toMatchObject({
      classification: "transient",
      reason: "transient_error_message",
    });
    expect(
      classifyRunFailureForRetry({
        errorCode: "adapter_failed",
        errorMessage: "controller lease lost",
      }),
    ).toMatchObject({
      classification: "transient",
      reason: "transient_error_message",
    });
    expect(
      classifyRunFailureForRetry({
        errorCode: "adapter_failed",
        errorMessage: "connect ECONNRESET 127.0.0.1:443",
      }),
    ).toMatchObject({
      classification: "transient",
      reason: "transient_error_message",
    });
    for (const errorMessage of [
      "No deployments available",
      "all deployments in cooldown",
      "all deployments are in cooldown",
      "All deployments for selected model are in cooldown",
      "HTTP 429 too many requests",
    ]) {
      expect(
        classifyRunFailureForRetry({ errorCode: "adapter_failed", errorMessage }),
      ).toMatchObject({
        classification: "transient",
        reason: "transient_error_message",
      });
    }
  });

  it("evaluates isTransientFailure and isPermanentAgentFailure accurately", () => {
    expect(isTransientFailure({ errorCode: "continuation_source_context_missing" })).toBe(true);
    expect(isTransientFailure({ errorCode: "stream_interrupted" })).toBe(true);
    expect(isTransientFailure({ errorCode: "controller_lease_lost" })).toBe(true);
    expect(isTransientFailure({ errorCode: "transient_network_error" })).toBe(true);
    expect(isTransientFailure({ errorMessage: "response stream was interrupted" })).toBe(true);
    expect(isTransientFailure({ errorMessage: "fetch failed" })).toBe(true);
    expect(isTransientFailure({ errorCode: "provider_quota" })).toBe(true); // Retryable run failure

    // Permanent agent failures
    expect(isPermanentAgentFailure({ errorCode: "provider_quota" })).toBe(true);
    expect(isPermanentAgentFailure({ errorCode: "continuation_user_authorization_missing" })).toBe(true);
    expect(isPermanentAgentFailure({ errorFamily: "refresh_token_reused" })).toBe(true);
    expect(isPermanentAgentFailure({ errorCode: "configuration_incomplete" })).toBe(true);
    expect(isPermanentAgentFailure({ errorMessage: "key not allowed to access model" })).toBe(true);

    // Transient errors are NOT permanent agent failures
    expect(isPermanentAgentFailure({ errorCode: "continuation_source_context_missing" })).toBe(false);
    expect(isPermanentAgentFailure({ errorCode: "stream_interrupted" })).toBe(false);
    expect(isPermanentAgentFailure({ errorCode: "controller_lease_lost" })).toBe(false);
    expect(isPermanentAgentFailure({ errorCode: "transient_network_error" })).toBe(false);
    expect(isPermanentAgentFailure({ errorMessage: "controller lease lost" })).toBe(false);
  });
});