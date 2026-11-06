import { describe, expect, it } from "vitest";
import {
  MODEL_UNAVAILABLE_RETRY_BASE_DELAY_MS,
  MODEL_UNAVAILABLE_RETRY_MAX_ATTEMPTS,
  MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS,
  classifyRunFailureForRetry,
  computeModelUnavailableRetryDelayMs,
  decideModelUnavailableRetryIssue,
  isModelUnavailableRun,
  isReplayableModelUnavailableRun,
} from "./index.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("model-unavailable retry: delay", () => {
  it("waits at least 30 minutes and doubles up to a 6 hour cap", () => {
    const delays = [1, 2, 3, 4, 5, 6, 12].map(computeModelUnavailableRetryDelayMs);
    expect(delays).toEqual([30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR]);
    expect(MODEL_UNAVAILABLE_RETRY_BASE_DELAY_MS).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(MODEL_UNAVAILABLE_RETRY_MAX_DELAY_MS).toBe(6 * HOUR);
  });

  it("never waits less than the first step, whatever the attempt number looks like", () => {
    for (const attempt of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 1.9]) {
      expect(computeModelUnavailableRetryDelayMs(attempt)).toBeGreaterThanOrEqual(30 * MINUTE);
    }
  });

  it("is bounded: a few attempts, not an endless loop", () => {
    expect(MODEL_UNAVAILABLE_RETRY_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(MODEL_UNAVAILABLE_RETRY_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});

describe("model-unavailable retry: run marker", () => {
  it("recognizes only the explicit adapter marker", () => {
    expect(isModelUnavailableRun({ resultJson: { model_unavailable: true } })).toBe(true);
    expect(isModelUnavailableRun({ resultJson: { provider_error_as_content: true } })).toBe(false);
    expect(isModelUnavailableRun({ resultJson: { model_unavailable: "yes" } })).toBe(false);
    expect(isModelUnavailableRun({ resultJson: null })).toBe(false);
    expect(isModelUnavailableRun({ resultJson: [] })).toBe(false);
    expect(isModelUnavailableRun({})).toBe(false);
  });

  it("replays a run only with positive evidence that nothing ran", () => {
    const bootstrap = { kind: "bootstrap", providerWorkStarted: false };
    expect(
      isReplayableModelUnavailableRun({ resultJson: { model_unavailable: true, executionRecovery: bootstrap } }),
    ).toBe(true);
    // A turn that made tool calls reports no evidence: it stays on the hold-and-ask path.
    expect(isReplayableModelUnavailableRun({ resultJson: { model_unavailable: true } })).toBe(false);
    expect(
      isReplayableModelUnavailableRun({
        resultJson: { model_unavailable: true, executionRecovery: { kind: "bootstrap", providerWorkStarted: true } },
      }),
    ).toBe(false);
    expect(isReplayableModelUnavailableRun({ resultJson: { executionRecovery: bootstrap } })).toBe(false);
  });

  it("is still a transient failure for the retry policy (reuses the existing family)", () => {
    expect(
      classifyRunFailureForRetry({ errorCode: "hermes_gateway_run_failed", errorFamily: "transient_upstream" }),
    ).toMatchObject({ classification: "transient" });
  });
});

describe("model-unavailable retry: issue gate", () => {
  const decide = (issue: { status: string; assigneeAgentId: string | null } | null) =>
    decideModelUnavailableRetryIssue({ issueId: "issue-1", runAgentId: "agent-1", issue });

  it.each(["todo", "in_progress"])("retries a %s issue still assigned to the agent", (status) => {
    expect(decide({ status, assigneeAgentId: "agent-1" })).toEqual({ allowed: true });
  });

  it.each(["backlog", "blocked", "in_review", "done", "cancelled"])(
    "does not retry a %s issue",
    (status) => {
      expect(decide({ status, assigneeAgentId: "agent-1" })).toMatchObject({
        allowed: false,
        errorCode: "issue_not_in_progress",
        details: { issueId: "issue-1", currentStatus: status },
      });
    },
  );

  it("does not retry an issue assigned to someone else or to nobody", () => {
    expect(decide({ status: "in_progress", assigneeAgentId: "agent-2" })).toMatchObject({
      allowed: false,
      errorCode: "issue_reassigned",
    });
    expect(decide({ status: "todo", assigneeAgentId: null })).toMatchObject({
      allowed: false,
      errorCode: "issue_reassigned",
    });
  });

  it("does not retry an issue that no longer exists", () => {
    expect(decide(null)).toMatchObject({ allowed: false, errorCode: "issue_not_found" });
  });
});
