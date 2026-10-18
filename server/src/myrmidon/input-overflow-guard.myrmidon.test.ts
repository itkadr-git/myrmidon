import { describe, expect, it } from "vitest";
import {
  DEFAULT_INPUT_OVERFLOW_MAX_FAILURES,
  buildInputOverflowAttentionComment,
  decideInputOverflowAction,
  detectInputOverflowRun,
  readInputOverflowMaxFailures,
} from "./input-overflow-guard.js";

describe("detectInputOverflowRun", () => {
  it("matches the DashScope incident wording on error text", () => {
    const match = detectInputOverflowRun({
      error: "InternalError.Algo.InvalidParameter: Range of input length should be [1, 1048576]",
      errorCode: "hermes_gateway_run_failed",
      resultJson: null,
    });
    expect(match?.provider).toBe("dashscope");
  });

  it("matches the wording carried only in resultJson.errorMessage", () => {
    expect(
      detectInputOverflowRun({
        error: "failed",
        resultJson: { errorMessage: "prompt is too long: 250000 tokens > 200000 maximum" },
      })?.provider,
    ).toBe("anthropic");
  });

  it("trusts a persisted input_overflow family", () => {
    expect(detectInputOverflowRun({ error: "boom", resultJson: { errorFamily: "input_overflow" } })).not.toBeNull();
  });

  it("does not match transient or unrelated failures", () => {
    expect(detectInputOverflowRun({ error: "Connection error.", resultJson: { errorFamily: "transient_upstream" } })).toBeNull();
  });
});

describe("decideInputOverflowAction", () => {
  it("retries with a fresh session below the limit and stops at it", () => {
    expect(decideInputOverflowAction(1, 3).action).toBe("fresh_session");
    expect(decideInputOverflowAction(2, 3).action).toBe("fresh_session");
    expect(decideInputOverflowAction(3, 3).action).toBe("stop");
    expect(decideInputOverflowAction(7, 3).action).toBe("stop");
  });
});

describe("readInputOverflowMaxFailures", () => {
  it("defaults and validates the env override", () => {
    expect(readInputOverflowMaxFailures({})).toBe(DEFAULT_INPUT_OVERFLOW_MAX_FAILURES);
    expect(readInputOverflowMaxFailures({ MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES: "5" })).toBe(5);
    expect(readInputOverflowMaxFailures({ MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES: "0" })).toBe(DEFAULT_INPUT_OVERFLOW_MAX_FAILURES);
    expect(readInputOverflowMaxFailures({ MYRMIDON_INPUT_OVERFLOW_MAX_FAILURES: "x" })).toBe(DEFAULT_INPUT_OVERFLOW_MAX_FAILURES);
  });
});

describe("buildInputOverflowAttentionComment", () => {
  it("carries the facts and the remedy", () => {
    const body = buildInputOverflowAttentionComment({
      match: { provider: "dashscope", pattern: "Range of input length should be" },
      consecutive: 3,
      max: 3,
      runId: "run-1",
      errorExcerpt: "Range of input length should be [1, 1048576]",
    });
    expect(body).toContain("3 consecutive runs");
    expect(body).toContain("run-1");
    expect(body).toContain("reset task session");
  });
});
