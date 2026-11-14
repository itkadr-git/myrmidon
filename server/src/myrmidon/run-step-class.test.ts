 import { describe, expect, it } from "vitest";
 import {
   classifyRunStep,
   classifyRunStepFromContextSnapshot,
   RUN_STEP_CLASSES,
   type RunStepClassification,
   type RunStepClassificationInput,
 } from "./run-step-class.js";
 
function classify(
  overrides: Partial<RunStepClassificationInput>,
): RunStepClassification {
  // Test seam: every assertion below reads the verdict through this one
  // gate so a signature change of classifyRunStep is one edit, not forty.
  return classifyRunStep(overrides as RunStepClassificationInput);
}

describe("classifyRunStep — one class per step", () => {
  it("exposes exactly the five epic classes", () => {
    expect([...RUN_STEP_CLASSES]).toEqual([
      "review",
      "acceptance",
      "decomposition",
      "execution",
      "background",
    ]);
  });

  it("classifies review by stage type, wake role, source and wake reason", () => {
    expect(classify({ executionStageType: "review" })).toEqual({
      stepClass: "review",
      rule: "review_stage_type",
    });
    expect(classify({ executionStageWakeRole: "reviewer" })).toEqual({
      stepClass: "review",
      rule: "reviewer_wake_role",
    });
    expect(classify({ source: "review_pickup" })).toEqual({
      stepClass: "review",
      rule: "review_source",
    });
    expect(classify({ wakeReason: "execution_review_requested" })).toEqual({
      stepClass: "review",
      rule: "review_wake_reason",
    });
    expect(
      classify({ wakeReason: "execution_review_participant_recovery" }),
    ).toEqual({ stepClass: "review", rule: "review_wake_reason" });
  });

  it("classifies acceptance by approval stage and approval wake reason", () => {
    expect(classify({ executionStageType: "approval" })).toEqual({
      stepClass: "acceptance",
      rule: "acceptance_stage_type",
    });
    expect(classify({ wakeReason: "execution_approval_requested" })).toEqual({
      stepClass: "acceptance",
      rule: "acceptance_wake_reason",
    });
  });

  it("classifies decomposition from the accepted-plan continuation signals", () => {
    expect(
      classify({ workspaceRefreshReason: "accepted_plan_confirmation" }),
    ).toEqual({ stepClass: "decomposition", rule: "accepted_plan_continuation" });
    expect(
      classify({
        issueWorkMode: "planning",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      }),
    ).toEqual({ stepClass: "decomposition", rule: "accepted_plan_continuation" });
    // A rejected plan confirmation is not a decomposition start.
    expect(
      classify({
        issueWorkMode: "planning",
        interactionKind: "request_confirmation",
        interactionStatus: "rejected",
      }),
    ).toEqual({ stepClass: "execution", rule: "default_execution" });
    // A confirmation interaction on a standard issue is not decomposition.
    expect(
      classify({
        issueWorkMode: "standard",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      }),
    ).toEqual({ stepClass: "execution", rule: "default_execution" });
  });

  it("classifies ordinary execution work", () => {
    for (const wakeReason of [
      "issue_commented",
      "issue_assigned",
      "issue_unblock_requested",
      "interaction_pending",
      "execution_changes_requested",
      "issue_children_completed",
    ]) {
      expect(classify({ wakeReason })).toEqual({
        stepClass: "execution",
        rule: "default_execution",
      });
    }
  });

  it("classifies retries as background", () => {
    expect(classify({ retryReason: "transient_failure" })).toEqual({
      stepClass: "background",
      rule: "retry",
    });
    expect(classify({ retryReason: "max_turns_continuation" })).toEqual({
      stepClass: "background",
      rule: "retry",
    });
    for (const wakeReason of [
      "transient_failure",
      "container_not_started",
      "missing_issue_comment",
      "provider_quota_recovery",
      "deferred_issue_execution_expired",
      "queued_run_stale_timeout",
      "ai_connection_busy_retry",
      "workspace_busy_retry",
      "max_turns_continuation_retry",
      "provider_garbage_retry",
    ]) {
      expect(classify({ wakeReason })).toEqual({
        stepClass: "background",
        rule: "retry",
      });
    }
  });

  it("classifies monitor and timer sweeps as background", () => {
    for (const wakeReason of [
      "issue_monitor_due",
      "issue_monitor_timeout",
      "issue_monitor_recovery",
      "issue_monitor_recovery_issue",
    ]) {
      expect(classify({ wakeReason })).toEqual({
        stepClass: "background",
        rule: "monitor",
      });
    }
    for (const wakeReason of ["heartbeat_timer", "goal_control", "dev_project_queue_empty"]) {
      expect(classify({ wakeReason })).toEqual({
        stepClass: "background",
        rule: "monitor",
      });
    }
    expect(classify({ source: "timer" })).toEqual({
      stepClass: "background",
      rule: "background",
    });
    expect(classify({ invocationSource: "timer" })).toEqual({
      stepClass: "background",
      rule: "background",
    });
  });

  it("is total: empty and unknown inputs land on execution", () => {
    expect(classify({})).toEqual({
      stepClass: "execution",
      rule: "default_execution",
    });
    expect(
      classify({
        wakeReason: "some_future_wake_reason",
        source: "some_future_source",
      }),
    ).toEqual({ stepClass: "execution", rule: "default_execution" });
    // Blank strings behave like absent ones.
    expect(classify({ wakeReason: "  ", retryReason: "" })).toEqual({
      stepClass: "execution",
      rule: "default_execution",
    });
  });
});

describe("classifyRunStep — conflicting signals", () => {
  it("review beats retry and monitor sweeps", () => {
    expect(
      classify({
        executionStageType: "review",
        wakeReason: "issue_monitor_due",
      }),
    ).toEqual({ stepClass: "review", rule: "review_stage_type" });
    expect(
      classify({
        wakeReason: "execution_review_requested",
        retryReason: "transient_failure",
      }),
    ).toEqual({ stepClass: "review", rule: "review_wake_reason" });
    expect(
      classify({
        executionStageWakeRole: "reviewer",
        wakeReason: "workspace_busy_retry",
      }),
    ).toEqual({ stepClass: "review", rule: "reviewer_wake_role" });
  });

  it("review stage type beats the acceptance stage type", () => {
    // Unreachable in production (one stage per run), but the priority must be
    // defined: the reviewer verdict wins over the gate.
    expect(
      classify({
        executionStageType: "review",
        executionStageWakeRole: "reviewer",
        source: "review_pickup",
      }),
    ).toEqual({ stepClass: "review", rule: "review_stage_type" });
  });

  it("acceptance beats decomposition and retry", () => {
    expect(
      classify({
        executionStageType: "approval",
        workspaceRefreshReason: "accepted_plan_confirmation",
      }),
    ).toEqual({ stepClass: "acceptance", rule: "acceptance_stage_type" });
    expect(
      classify({
        wakeReason: "execution_approval_requested",
        retryReason: "transient_failure",
      }),
    ).toEqual({ stepClass: "acceptance", rule: "acceptance_wake_reason" });
  });

  it("decomposition beats retry and monitor", () => {
    expect(
      classify({
        workspaceRefreshReason: "accepted_plan_confirmation",
        retryReason: "transient_failure",
        wakeReason: "issue_monitor_due",
      }),
    ).toEqual({ stepClass: "decomposition", rule: "accepted_plan_continuation" });
  });

  it("retry beats the generic monitor and timer signals", () => {
    expect(
      classify({
        retryReason: "transient_failure",
        wakeReason: "issue_monitor_due",
      }),
    ).toEqual({ stepClass: "background", rule: "retry" });
  });
});

describe("classifyRunStepFromContextSnapshot", () => {
  it("reads the production snapshot shape", () => {
    expect(
      classifyRunStepFromContextSnapshot({
        wakeReason: "execution_review_requested",
        source: "review_pickup",
        executionStage: { wakeRole: "reviewer", stageType: "review" },
      }),
    ).toEqual({ stepClass: "review", rule: "review_stage_type" });
    expect(
      classifyRunStepFromContextSnapshot(
        {
          wakeReason: "issue_commented",
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
        "planning",
      ),
    ).toEqual({ stepClass: "decomposition", rule: "accepted_plan_continuation" });
  });

  it("tolerates junk snapshots and blank work modes", () => {
    expect(classifyRunStepFromContextSnapshot(null)).toEqual({
      stepClass: "execution",
      rule: "default_execution",
    });
    expect(classifyRunStepFromContextSnapshot("not an object")).toEqual({
      stepClass: "execution",
      rule: "default_execution",
    });
    expect(classifyRunStepFromContextSnapshot([1, 2, 3])).toEqual({
      stepClass: "execution",
      rule: "default_execution",
    });
    expect(
      classifyRunStepFromContextSnapshot({ executionStage: "junk" }),
    ).toEqual({ stepClass: "execution", rule: "default_execution" });
    expect(
      classifyRunStepFromContextSnapshot({ executionStage: null }, "  "),
    ).toEqual({ stepClass: "execution", rule: "default_execution" });
  });
});
