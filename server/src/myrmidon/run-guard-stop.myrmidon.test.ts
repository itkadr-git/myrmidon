import { describe, expect, it } from "vitest";
import { RUN_GUARD_STOP_REASONS } from "@myrmidon/adapter-utils/run-guard";
import { MAINTENANCE_INTERRUPT_ERROR_CODE } from "./maintenance/domain.js";
import {
  CALL_LIMIT_CONTINUATION_HINT,
  RUN_GUARD_CONTINUATION_CONTEXT_KEY,
  buildRunGuardStopComment,
  buildRunGuardStopNotice,
  findPreviousLimitStopRun,
  isRepeatedEmptyLimitStop,
  isRunGuardLimitStopReason,
  runHasUsefulOutcome,
  maxTurnContinuationSchedulerCeiling,
  parseRunGuardContinuationPolicy,
  readRunGuardContinuationCount,
  readRunGuardStopReason,
  readRunGuardWriteCalls,
  runGuardContinuationSchedulerCeiling,
  shouldContinueAfterRunGuardStop,
} from "./run-guard-stop.js";
import {
  PERMANENT_RUN_FAILURE_ERROR_CODES,
  classifyRunFailureForRetry,
  isTransientFailure,
} from "./run-retry-policy/classification.js";
import { planRunRetry } from "./run-retry-policy/policy.js";
import { inferHeartbeatRunStopReason } from "../services/heartbeat-stop-metadata.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";

describe("readRunGuardStopReason", () => {
  it("reads the stop reason from the run error code or from the persisted result", () => {
    for (const reason of RUN_GUARD_STOP_REASONS) {
      expect(readRunGuardStopReason({ errorCode: reason })).toBe(reason);
      expect(readRunGuardStopReason({ errorCode: "cancelled", resultJson: { runGuardStopReason: reason } })).toBe(reason);
    }
  });

  it("returns null for every other run: transport failures, maintenance, plain cancellations", () => {
    for (const errorCode of [
      "hermes_gateway_connect_failed",
      "rate_limited",
      "provider_quota",
      "adapter_failed",
      "cancelled",
      "timeout",
      MAINTENANCE_INTERRUPT_ERROR_CODE,
      null,
      undefined,
    ]) {
      expect(readRunGuardStopReason({ errorCode, resultJson: {} })).toBeNull();
    }
    expect(readRunGuardStopReason(null)).toBeNull();
    expect(readRunGuardStopReason({ errorCode: null, resultJson: "model_call_limit" })).toBeNull();
    expect(readRunGuardStopReason({ errorCode: null, resultJson: { runGuardStopReason: "something_else" } })).toBeNull();
  });
});

describe("buildRunGuardStopComment", () => {
  it("says why the run was stopped, how many calls were made without a write, and that no retry follows", () => {
    expect(
      buildRunGuardStopComment({ errorCode: "no_progress_exploration" }, { readOnlyStreak: 40, modelCalls: 41 }),
    ).toBe(
      "Прогон остановлен защитой: только чтение без изменений (40 вызовов без записи). " +
        "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
    );
    expect(buildRunGuardStopComment({ errorCode: "repeated_tool_call" }, { readOnlyStreak: 7 })).toContain(
      "повтор одного и того же вызова (7 вызовов без записи)",
    );
  });

  it("names every stop reason", () => {
    const labels = new Set<string>();
    for (const reason of RUN_GUARD_STOP_REASONS) {
      const comment = buildRunGuardStopComment({ errorCode: reason });
      expect(comment).toContain("Прогон остановлен защитой: ");
      expect(comment).toContain("автоповтора не будет.");
      labels.add(comment!);
    }
    expect(labels.size).toBe(RUN_GUARD_STOP_REASONS.length);
  });

  it("falls back to the model call count, then to no count at all", () => {
    expect(buildRunGuardStopComment({ errorCode: "model_call_limit" }, { readOnlyStreak: 0, modelCalls: 150 })).toContain(
      "лимит вызовов модели (150 вызовов модели)",
    );
    expect(buildRunGuardStopComment({ errorCode: "model_call_limit" })).toContain("лимит вызовов модели. Нужна");
  });

  it("reads the counts the heartbeat persisted with the run when none are passed", () => {
    expect(
      buildRunGuardStopComment({
        errorCode: "tool_retry_loop",
        resultJson: { runGuardStopReason: "tool_retry_loop", runGuardStats: { readOnlyStreak: 12, modelCalls: 30 } },
      }),
    ).toContain("(12 вызовов без записи)");
  });

  it.each([
    [1, "1 вызов без записи"],
    [2, "2 вызова без записи"],
    [4, "4 вызова без записи"],
    [5, "5 вызовов без записи"],
    [11, "11 вызовов без записи"],
    [14, "14 вызовов без записи"],
    [21, "21 вызов без записи"],
    [22, "22 вызова без записи"],
    [40, "40 вызовов без записи"],
    [112, "112 вызовов без записи"],
  ])("declines the call count %i", (count, expected) => {
    expect(buildRunGuardStopComment({ errorCode: "no_progress_exploration" }, { readOnlyStreak: count })).toContain(`(${expected})`);
  });

  it("returns null for a run the guard did not stop", () => {
    expect(buildRunGuardStopComment({ errorCode: "hermes_gateway_connect_failed" })).toBeNull();
    expect(buildRunGuardStopNotice({ errorCode: "adapter_failed" })).toBeNull();
  });
});

describe("buildRunGuardStopNotice", () => {
  it("carries the comment as the notice body", () => {
    const notice = buildRunGuardStopNotice({ errorCode: "no_progress_exploration" }, { readOnlyStreak: 40 });
    expect(notice).toMatchObject({ title: "Прогон остановлен защитой", tone: "danger" });
    expect(notice?.body).toBe(buildRunGuardStopComment({ errorCode: "no_progress_exploration" }, { readOnlyStreak: 40 }));
    expect(notice?.nextAction).toContain("новую вводную");
  });
});

// myrmidon(RUN-GUARD-CONTINUE): a call-limit stop of a run that made changes is work, not a loop.
describe("readRunGuardWriteCalls", () => {
  it("reads the count from the passed statistics, else from the ones stored with the run", () => {
    expect(readRunGuardWriteCalls({ errorCode: "model_call_limit" }, { writeCalls: 27 })).toBe(27);
    expect(
      readRunGuardWriteCalls({
        errorCode: "model_call_limit",
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: { writeCalls: 5, modelCalls: 150 } },
      }),
    ).toBe(5);
    // Passed statistics win over the stored ones.
    expect(
      readRunGuardWriteCalls(
        { errorCode: "model_call_limit", resultJson: { runGuardStats: { writeCalls: 5 } } },
        { writeCalls: 9 },
      ),
    ).toBe(9);
  });

  it("is 0 when the count is missing or not a positive number", () => {
    expect(readRunGuardWriteCalls({ errorCode: "model_call_limit" })).toBe(0);
    expect(readRunGuardWriteCalls(null)).toBe(0);
    expect(readRunGuardWriteCalls({ errorCode: "model_call_limit" }, { modelCalls: 150 })).toBe(0);
    for (const writeCalls of [0, -3, Number.NaN, "7", null]) {
      expect(readRunGuardWriteCalls({ errorCode: "model_call_limit" }, { writeCalls } as never)).toBe(0);
    }
  });
});

describe("shouldContinueAfterRunGuardStop", () => {
  it("continues a call-limit stop of a run that made changes", () => {
    expect(shouldContinueAfterRunGuardStop({ errorCode: "model_call_limit" }, { modelCalls: 150, writeCalls: 27 })).toBe(true);
    expect(
      shouldContinueAfterRunGuardStop({
        errorCode: "cancelled",
        resultJson: { runGuardStopReason: "model_call_limit", runGuardStats: { writeCalls: 1 } },
      }),
    ).toBe(true);
  });

  it("does not continue a call-limit stop of a run that changed nothing, or that has no count", () => {
    expect(shouldContinueAfterRunGuardStop({ errorCode: "model_call_limit" }, { modelCalls: 150, writeCalls: 0 })).toBe(false);
    expect(shouldContinueAfterRunGuardStop({ errorCode: "model_call_limit" }, { modelCalls: 150, readOnlyStreak: 33 })).toBe(false);
    expect(shouldContinueAfterRunGuardStop({ errorCode: "model_call_limit" })).toBe(false);
  });

  it("never continues the other stops, whatever the run changed", () => {
    for (const reason of RUN_GUARD_STOP_REASONS) {
      if (reason === "model_call_limit" || reason === "no_progress_exploration") continue;
      expect(shouldContinueAfterRunGuardStop({ errorCode: reason }, { modelCalls: 60, writeCalls: 50 })).toBe(false);
    }
  });

  // myrmidon(OPE-12004): no_progress_exploration gets one auto-retry with a hint
  it("continues a no_progress_exploration stop", () => {
    expect(shouldContinueAfterRunGuardStop({ errorCode: "no_progress_exploration" })).toBe(true);
    expect(
      shouldContinueAfterRunGuardStop({
        errorCode: "cancelled",
        resultJson: { runGuardStopReason: "no_progress_exploration" },
      }),
    ).toBe(true);
  });

  it("is false for a run the guard did not stop", () => {
    expect(shouldContinueAfterRunGuardStop(null, { writeCalls: 50 })).toBe(false);
    expect(shouldContinueAfterRunGuardStop({ errorCode: "adapter_failed" }, { writeCalls: 50 })).toBe(false);
    expect(shouldContinueAfterRunGuardStop({ errorCode: "hermes_gateway_connect_failed" }, { writeCalls: 50 })).toBe(false);
  });

  it("leaves the final-stop comment of an exhausted continuation as it was", () => {
    expect(buildRunGuardStopComment({ errorCode: "model_call_limit" }, { readOnlyStreak: 0, modelCalls: 150, writeCalls: 27 })).toBe(
      "Прогон остановлен защитой: лимит вызовов модели (150 вызовов модели). " +
        "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
    );
  });
});

describe("guard stops are never retried (retry taxonomy)", () => {
  it("lists every guard stop reason as a permanent failure", () => {
    for (const reason of RUN_GUARD_STOP_REASONS) {
      expect(PERMANENT_RUN_FAILURE_ERROR_CODES.has(reason)).toBe(true);
      expect(classifyRunFailureForRetry({ errorCode: reason })).toMatchObject({
        classification: "permanent",
        reason: "permanent_error_code",
      });
      expect(isTransientFailure({ errorCode: reason })).toBe(false);
      expect(planRunRetry({ failure: { errorCode: reason }, attempt: 1, now: new Date("2030-01-01T00:00:00Z") })).toMatchObject({
        retry: false,
        reason: "permanent_failure",
      });
    }
  });

  it("keeps transient failures retryable", () => {
    for (const errorCode of ["provider_quota", "stream_interrupted", "adapter_failed"]) {
      expect(planRunRetry({ failure: { errorCode }, attempt: 1, now: new Date("2030-01-01T00:00:00Z") })).toMatchObject({
        retry: true,
      });
    }
  });
});

describe("guard stop metadata", () => {
  it("maps the new error codes to the stop reason of the same name", () => {
    for (const reason of RUN_GUARD_STOP_REASONS) {
      expect(inferHeartbeatRunStopReason({ outcome: "cancelled", errorCode: reason })).toBe(reason);
      expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: reason })).toBe(reason);
    }
  });

  it("does not hold guard-stopped runs in reconciliation, and still holds other cancelled runs", () => {
    for (const reason of RUN_GUARD_STOP_REASONS) {
      expect(
        legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "cancelled", errorCode: reason, resultJson: {} }),
      ).toBe(false);
    }
    expect(
      legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled", resultJson: {} }),
    ).toBe(true);
  });
});

// myrmidon(RUN-GUARD-CONTINUE): call-limit continuations have their own ceiling.
describe("parseRunGuardContinuationPolicy", () => {
  it("defaults to enabled with 6 continuations", () => {
    for (const runtimeConfig of [undefined, null, {}, { heartbeat: {} }, { heartbeat: { runGuardContinuation: {} } }]) {
      expect(parseRunGuardContinuationPolicy(runtimeConfig)).toEqual({ enabled: true, maxAttempts: 6 });
    }
  });

  it("reads heartbeat.runGuardContinuation and caps the ceiling at 20", () => {
    const policy = (runGuardContinuation: unknown) => parseRunGuardContinuationPolicy({ heartbeat: { runGuardContinuation } });
    expect(policy({ maxAttempts: 4 })).toEqual({ enabled: true, maxAttempts: 4 });
    expect(policy({ maxAttempts: 20 }).maxAttempts).toBe(20);
    expect(policy({ maxAttempts: 21 }).maxAttempts).toBe(20);
    expect(policy({ maxAttempts: 500 }).maxAttempts).toBe(20);
    expect(policy({ maxAttempts: 3.9 }).maxAttempts).toBe(3);
    expect(policy({ maxAttempts: -2 }).maxAttempts).toBe(0);
    expect(policy({ enabled: false })).toEqual({ enabled: false, maxAttempts: 6 });
  });

  it("falls back to the default for a value that is not a number", () => {
    for (const maxAttempts of ["7", null, Number.NaN, {}]) {
      expect(
        parseRunGuardContinuationPolicy({ heartbeat: { runGuardContinuation: { maxAttempts } } }).maxAttempts,
      ).toBe(6);
    }
  });

  it("does not read the max-turn ceiling", () => {
    expect(parseRunGuardContinuationPolicy({ heartbeat: { maxTurnContinuation: { maxAttempts: 1 } } }).maxAttempts).toBe(6);
  });
});

describe("call-limit continuation ceilings", () => {
  it("counts the continuations of the chain from the run context, 0 outside a chain", () => {
    expect(readRunGuardContinuationCount({ contextSnapshot: { [RUN_GUARD_CONTINUATION_CONTEXT_KEY]: 3 } })).toBe(3);
    expect(readRunGuardContinuationCount({ contextSnapshot: {} })).toBe(0);
    expect(readRunGuardContinuationCount({ contextSnapshot: { [RUN_GUARD_CONTINUATION_CONTEXT_KEY]: "3" } })).toBe(0);
    expect(readRunGuardContinuationCount(null)).toBe(0);
  });

  it("gives the scheduler the shared counter plus what is left of the own ceiling, or null when it is spent", () => {
    // Three continuations made along a chain whose shared counter stands at 3: the 4th needs a ceiling of 3 + 7.
    expect(runGuardContinuationSchedulerCeiling({ scheduledRetryAttempt: 3, continuationsMade: 3, maxAttempts: 10 })).toBe(10);
    expect(runGuardContinuationSchedulerCeiling({ scheduledRetryAttempt: null, continuationsMade: 0, maxAttempts: 10 })).toBe(10);
    expect(runGuardContinuationSchedulerCeiling({ scheduledRetryAttempt: 12, continuationsMade: 9, maxAttempts: 10 })).toBe(13);
    expect(runGuardContinuationSchedulerCeiling({ scheduledRetryAttempt: 10, continuationsMade: 10, maxAttempts: 10 })).toBeNull();
    expect(runGuardContinuationSchedulerCeiling({ scheduledRetryAttempt: 2, continuationsMade: 0, maxAttempts: 0 })).toBeNull();
  });

  it("leaves the max-turn ceiling whole by the continuations the call limit already made", () => {
    expect(maxTurnContinuationSchedulerCeiling(2, { contextSnapshot: {} })).toBe(2);
    expect(maxTurnContinuationSchedulerCeiling(2, { contextSnapshot: { [RUN_GUARD_CONTINUATION_CONTEXT_KEY]: 3 } })).toBe(5);
  });
});

// myrmidon(OPE-12799): the second limit stop in a row without a result is final.
describe("repeated empty limit stops (OPE-12799)", () => {
  const callLimit = { errorCode: "model_call_limit", status: "cancelled" };
  const noProgress = { errorCode: "no_progress_exploration", status: "cancelled" };
  const empty = { issueCommentsCreated: 0, documentRevisionsCreated: 0, workProductsCreated: 0 };

  it("counts a comment, a document revision or a work product as the result of a run, and nothing else", () => {
    expect(runHasUsefulOutcome(empty)).toBe(false);
    expect(runHasUsefulOutcome(null)).toBe(false);
    expect(runHasUsefulOutcome({})).toBe(false);
    expect(runHasUsefulOutcome({ ...empty, issueCommentsCreated: 1 })).toBe(true);
    expect(runHasUsefulOutcome({ ...empty, documentRevisionsCreated: 1 })).toBe(true);
    expect(runHasUsefulOutcome({ ...empty, workProductsCreated: 2 })).toBe(true);
    // Tool calls and activity are not a result: 150 calls of execute_code leave nothing.
    expect(
      runHasUsefulOutcome({ ...empty, toolOrActionEventsCreated: 150, activityEventsCreated: 3 } as never),
    ).toBe(false);
  });

  it("takes the two limits as limit stops and no other reason", () => {
    expect(isRunGuardLimitStopReason("model_call_limit")).toBe(true);
    expect(isRunGuardLimitStopReason("no_progress_exploration")).toBe(true);
    expect(isRunGuardLimitStopReason("repeated_tool_call")).toBe(false);
    expect(isRunGuardLimitStopReason("tool_retry_loop")).toBe(false);
    expect(isRunGuardLimitStopReason("idle_timeout")).toBe(false);
    expect(isRunGuardLimitStopReason(null)).toBe(false);
  });

  it("finds the previous limit stop of the issue, newest first", () => {
    const previous = { id: "p1", ...callLimit };
    expect(findPreviousLimitStopRun([previous, { id: "p0", errorCode: null, status: "succeeded" }])).toBe(previous);
    expect(findPreviousLimitStopRun([{ id: "p1", ...noProgress }])?.id).toBe("p1");
    expect(findPreviousLimitStopRun([])).toBeNull();
  });

  it("skips runs that say nothing about the task: transport failures, maintenance, cancellations", () => {
    const previous = { id: "p1", ...callLimit };
    expect(
      findPreviousLimitStopRun([
        { id: "p3", errorCode: MAINTENANCE_INTERRUPT_ERROR_CODE, status: "interrupted" },
        { id: "p2", errorCode: "adapter_failed", status: "failed" },
        { id: "p2c", errorCode: null, status: "cancelled" },
        previous,
      ]),
    ).toBe(previous);
  });

  it("does not look past a run that succeeded or a guard stop of another kind", () => {
    expect(
      findPreviousLimitStopRun([{ id: "p2", errorCode: null, status: "succeeded" }, { id: "p1", ...callLimit }]),
    ).toBeNull();
    expect(
      findPreviousLimitStopRun([
        { id: "p2", errorCode: "repeated_tool_call", status: "failed" },
        { id: "p1", ...callLimit },
      ]),
    ).toBeNull();
  });

  it("makes the second empty limit stop in a row final, although the run made 'write' calls", () => {
    // Prod, 11.11: 806494c1 (149 execute_code) then its continuation 139ee93f, both left nothing.
    const run = { ...callLimit, resultJson: { runGuardStats: { modelCalls: 150, writeCalls: 149 } } };
    expect(shouldContinueAfterRunGuardStop(run)).toBe(true);
    expect(
      isRepeatedEmptyLimitStop({ run, runHasUsefulOutcome: false, previousLimitStop: { hasUsefulOutcome: false } }),
    ).toBe(true);
    expect(
      isRepeatedEmptyLimitStop({
        run: noProgress,
        runHasUsefulOutcome: false,
        previousLimitStop: { hasUsefulOutcome: false },
      }),
    ).toBe(true);
  });

  it("leaves the first limit stop, and a stop next to a run with a result, to the continuation rules", () => {
    expect(isRepeatedEmptyLimitStop({ run: callLimit, runHasUsefulOutcome: false, previousLimitStop: null })).toBe(false);
    expect(
      isRepeatedEmptyLimitStop({ run: callLimit, runHasUsefulOutcome: true, previousLimitStop: { hasUsefulOutcome: false } }),
    ).toBe(false);
    expect(
      isRepeatedEmptyLimitStop({ run: callLimit, runHasUsefulOutcome: false, previousLimitStop: { hasUsefulOutcome: true } }),
    ).toBe(false);
  });

  it("is false for a run the guard did not stop at a limit", () => {
    const previousLimitStop = { hasUsefulOutcome: false };
    expect(
      isRepeatedEmptyLimitStop({ run: { errorCode: "repeated_tool_call" }, runHasUsefulOutcome: false, previousLimitStop }),
    ).toBe(false);
    expect(
      isRepeatedEmptyLimitStop({ run: { errorCode: "adapter_failed" }, runHasUsefulOutcome: false, previousLimitStop }),
    ).toBe(false);
  });

  it("tells the lead that two runs in a row left nothing and the retry is stopped", () => {
    const text = buildRunGuardStopComment(callLimit, { modelCalls: 150, writeCalls: 149 }, { repeatedEmpty: true });
    expect(text).toBe(
      "Второй прогон подряд остановлен защитой без результата: лимит вызовов модели (150 вызовов модели). " +
        "Ни один из двух прогонов не оставил ни коммита, ни комментария, ни документа. Автоповтор остановлен. " +
        "Нужна новая вводная: уточнить задачу или разбить её на части по 1–2 часа.",
    );
    expect(buildRunGuardStopNotice(callLimit, { modelCalls: 150 }, { repeatedEmpty: true })?.body).toBe(
      buildRunGuardStopComment(callLimit, { modelCalls: 150 }, { repeatedEmpty: true }),
    );
    // The ordinary final stop keeps its text.
    expect(buildRunGuardStopComment(callLimit, { modelCalls: 150 })).toBe(
      "Прогон остановлен защитой: лимит вызовов модели (150 вызовов модели). " +
        "Нужна новая вводная: уточнить задачу или разбить её; автоповтора не будет.",
    );
  });

  it("tells the continuation of a call-limit stop to pick the work up, not to start over", () => {
    expect(CALL_LIMIT_CONTINUATION_HINT).toContain("Не начинай задачу заново");
    expect(CALL_LIMIT_CONTINUATION_HINT).toContain("git status");
    expect(CALL_LIMIT_CONTINUATION_HINT).toContain("закоммить и запушь");
  });
});
