import { describe, expect, it } from "vitest";
import {
  describeRunRetryState,
  formatRetryAttemptCounter,
  formatRetryClassification,
  formatRetryReason,
} from "./runRetryState";

describe("runRetryState", () => {
  it("formats internal retry reasons for operators", () => {
    expect(formatRetryReason("transient_failure")).toBe("Transient failure");
    expect(formatRetryReason("issue_continuation_needed")).toBe("Continuation needed");
    expect(formatRetryReason("max_turns_continuation")).toBe("Max-turn continuation");
    expect(formatRetryReason("custom_reason")).toBe("custom reason");
  });

  it("describes scheduled retries", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Retry scheduled",
      detail: "Attempt 2 · Transient failure",
    });
  });

  it("describes max-turn continuation retries distinctly", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-max-turns",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "max_turns_continuation",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      badgeLabel: "Continuation scheduled",
      detail: "Attempt 1 · Max-turn continuation",
    });
  });

  it("describes exhausted retries", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 4,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued",
      }),
    ).toMatchObject({
      kind: "exhausted",
      badgeLabel: "Retry exhausted",
      detail: "Attempt 4 · Transient failure · Automatic retries exhausted",
      secondary: "Bounded retry exhausted after 4 scheduled attempts; no further automatic retry will be queued Manual intervention required.",
    });
  });

  // myrmidon(1.6.6 RUN-RETRY-POLICY): the counter names the attempt ceiling the
  // scheduler enforced, and the class of the failure behind the retry.
  it("names the attempt ceiling the retry policy recorded", () => {
    expect(formatRetryAttemptCounter(2, 3)).toBe("Attempt 2 of 3");
    expect(formatRetryAttemptCounter(2, null)).toBe("Attempt 2");
    expect(formatRetryAttemptCounter(2)).toBe("Attempt 2");
    expect(formatRetryAttemptCounter(1, 0)).toBe("Attempt 1");
    expect(formatRetryAttemptCounter(null, 3)).toBeNull();
    expect(formatRetryAttemptCounter(0, 3)).toBeNull();
  });

  it("labels the failure class behind a retry", () => {
    expect(formatRetryClassification("transient")).toBe("Transient failure");
    expect(formatRetryClassification("permanent")).toBe("Permanent failure");
    expect(formatRetryClassification("unknown")).toBe("Unclassified failure");
    expect(formatRetryClassification("future_class")).toBe("future class");
    expect(formatRetryClassification(null)).toBeNull();
    expect(formatRetryClassification(undefined)).toBeNull();
  });

  it("carries the ceiling and the class into the retry summary", () => {
    expect(
      describeRunRetryState({
        status: "scheduled_retry",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryMaxAttempts: 3,
        scheduledRetryClassification: "transient",
        scheduledRetryReason: "transient_failure",
        scheduledRetryAt: "2026-04-18T20:15:00.000Z",
      }),
    ).toMatchObject({
      kind: "scheduled",
      detail: "Attempt 2 of 3 · Transient failure",
    });
  });

  it("keeps the bare attempt number for retries queued before the policy", () => {
    expect(
      describeRunRetryState({
        status: "failed",
        retryOfRunId: "run-1",
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "transient_failure",
        retryExhaustedReason: "Bounded retry exhausted",
      }),
    ).toMatchObject({
      kind: "exhausted",
      detail: "Attempt 2 · Transient failure · Automatic retries exhausted",
    });
  });
});
