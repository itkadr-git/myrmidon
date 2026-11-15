// server/src/myrmidon/goal-judge/controller.myrmidon.test.ts
//
// myrmidon(1.7-GOAL-JUDGE): unit tests for the review-cycle round controller.
//
// Acceptance criteria:
// - complete=false returns task to executor with missing criteria list
//   (status: in_progress + comment)
// - round counting <= 3
// - round 1 missing -> return to executor
// - round 2 complete -> pass (status: in_review)
// - round 3 missing -> escalate to reviewer with judge report (score/missing)
// - switch off -> noop (does not block review transition)
// - criteria missing -> noop
// - task not in review -> noop

import { describe, expect, it } from "vitest";
import {
  createGoalJudgeRoundController,
  createInMemoryGoalJudgeLedger,
  formatGoalJudgeEscalationComment,
  formatGoalJudgeReturnComment,
  resolveMaxRounds,
  type GoalJudgeReviewTaskFacts,
  type GoalJudgeRoundControllerDeps,
} from "./controller.js";
import type { GoalJudgeSettingsService } from "./settings.js";
import type { GoalJudgeVerdict } from "./domain.js";
import type {
  GoalJudgeModelCallInput,
  GoalJudgeModelCallResult,
  GoalJudgeModelPort,
} from "./wiring.js";

function fakeSettings(
  enabled: boolean,
  maxRounds: number = 3,
): Pick<GoalJudgeSettingsService, "read"> {
  return {
    async read() {
      return {
        enabled,
        providerId: "fake-provider-id",
        model: "test-model",
        maxTokens: 1024,
        temperature: 0,
        maxRounds,
        timeoutMs: 5000,
        promptTemplate: null,
      };
    },
  };
}

function fakeModelPort(outputs: GoalJudgeVerdict[]): GoalJudgeModelPort & { readonly calls: number } {
  let callIdx = 0;
  return {
    get calls() {
      return callIdx;
    },
    async call(_input: GoalJudgeModelCallInput): Promise<GoalJudgeModelCallResult> {
      const out = outputs[callIdx] ?? outputs[outputs.length - 1];
      callIdx++;
      return {
        content: JSON.stringify(out),
        promptTokens: 100,
        completionTokens: 50,
      };
    },
  };
}

describe("GoalJudge Round Controller (OPE-12149)", () => {
  it("switch off -> noop (does not block review)", async () => {
    const models = fakeModelPort([{ score: 0, missing: ["foo"], complete: false }]);
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(false),
      models,
    };
    const controller = createGoalJudgeRoundController(deps);

    const decision = await controller.judge({
      issueId: "issue-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion 1"],
      diff: "diff --git a/foo.ts b/foo.ts",
      testOutput: "PASS test",
    });

    expect(decision.kind).toBe("noop");
    if (decision.kind === "noop") {
      expect(decision.reason).toBe("goal_judge_disabled");
    }
    expect(models.calls).toBe(0);
  });

  it("task not in in_review -> noop", async () => {
    const models = fakeModelPort([{ score: 1, missing: [], complete: true }]);
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(true),
      models,
    };
    const controller = createGoalJudgeRoundController(deps);

    const decision = await controller.judge({
      issueId: "issue-1",
      companyId: "comp-1",
      status: "in_progress",
      criteria: ["Criterion 1"],
    });

    expect(decision.kind).toBe("noop");
    if (decision.kind === "noop") {
      expect(decision.reason).toBe("not_a_review_task");
    }
  });

  it("missing criteria -> noop", async () => {
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(true),
      models: fakeModelPort([]),
    };
    const controller = createGoalJudgeRoundController(deps);

    const decision = await controller.judge({
      issueId: "issue-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: [],
    });

    expect(decision.kind).toBe("noop");
    if (decision.kind === "noop") {
      expect(decision.reason).toBe("missing_criteria");
    }
  });

  it("round 1 missing -> returns to executor with in_progress and missing criteria comment", async () => {
    const models = fakeModelPort([
      {
        score: 0.4,
        missing: ["Criterion B is missing", "No test output for C"],
        complete: false,
        summary: "Needs further tests.",
      },
    ]);
    const ledger = createInMemoryGoalJudgeLedger();
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(true, 3),
      models,
      ledger,
    };
    const controller = createGoalJudgeRoundController(deps);

    const task: GoalJudgeReviewTaskFacts = {
      issueId: "issue-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion A", "Criterion B", "Criterion C"],
      diff: "diff --git a/foo.ts b/foo.ts",
      testOutput: "PASS foo",
      headSha: "sha-1",
      returnAssigneeAgentId: "eng-1",
    };

    const decision = await controller.judge(task);

    expect(decision.kind).toBe("return_to_executor");
    if (decision.kind === "return_to_executor") {
      expect(decision.roundsUsed).toBe(1);
      expect(decision.patch.status).toBe("in_progress");
      expect(decision.patch.assigneeAgentId).toBe("eng-1");
      expect(decision.commentBody).toContain("Criterion B is missing");
      expect(decision.commentBody).toContain("round 1/3");
      expect(decision.verdict.complete).toBe(false);
      expect(decision.verdict.missing).toHaveLength(2);
    }

    const state = await ledger.load("comp-1", "issue-1");
    expect(state?.rounds).toBe(1);
    expect(state?.lastHeadSha).toBe("sha-1");
  });

  it("round 2 complete -> pass (allowed into review)", async () => {
    const models = fakeModelPort([
      // round 1
      {
        score: 0.5,
        missing: ["Feature X missing"],
        complete: false,
      },
      // round 2
      {
        score: 1.0,
        missing: [],
        complete: true,
        summary: "All criteria verified.",
      },
    ]);
    const ledger = createInMemoryGoalJudgeLedger();
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(true, 3),
      models,
      ledger,
    };
    const controller = createGoalJudgeRoundController(deps);

    // Round 1
    const res1 = await controller.judge({
      issueId: "issue-2",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Feature X"],
      diff: "diff 1",
      testOutput: "PASS",
      headSha: "sha-1",
    });
    expect(res1.kind).toBe("return_to_executor");

    // Round 2 (new head sha pushed)
    const res2 = await controller.judge({
      issueId: "issue-2",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Feature X"],
      diff: "diff 2 with Feature X",
      testOutput: "PASS Feature X",
      headSha: "sha-2",
    });
    expect(res2.kind).toBe("pass");
    if (res2.kind === "pass") {
      expect(res2.roundsUsed).toBe(2);
      expect(res2.verdict.complete).toBe(true);
      expect(res2.verdict.missing).toHaveLength(0);
    }
  });

  it("3 missing rounds -> escalates to reviewer with report (score & missing)", async () => {
    const models = fakeModelPort([
      { score: 0.2, missing: ["Criterion 1"], complete: false },
      { score: 0.4, missing: ["Criterion 1"], complete: false },
      { score: 0.5, missing: ["Criterion 1"], complete: false },
    ]);
    const ledger = createInMemoryGoalJudgeLedger();
    const deps: GoalJudgeRoundControllerDeps = {
      settings: fakeSettings(true, 3),
      models,
      ledger,
    };
    const controller = createGoalJudgeRoundController(deps);

    // Round 1
    const res1 = await controller.judge({
      issueId: "issue-3",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion 1"],
      headSha: "sha-1",
    });
    expect(res1.kind).toBe("return_to_executor");

    // Round 2
    const res2 = await controller.judge({
      issueId: "issue-3",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion 1"],
      headSha: "sha-2",
    });
    expect(res2.kind).toBe("return_to_executor");

    // Round 3 (reaches maxRounds limit)
    const res3 = await controller.judge({
      issueId: "issue-3",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion 1"],
      headSha: "sha-3",
      defaultEscalationAgentIds: ["adm-dev-review-8"],
      executionPolicy: {
        mode: "normal",
        commentRequired: false,
        stages: [
          {
            id: "stage-1",
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: "part-1", type: "agent", agentId: "adm-dev-review-8" }],
          },
        ],
        reviewEscalationPolicy: {
          policyRevision: "1.0",
          participantRoles: ["secondary_reviewer"],
          fallbackQueue: "default",
          timeoutAt: null,
          maxReviewRounds: 3,
        },
      },
    });

    expect(res3.kind).toBe("escalate_to_reviewer");
    if (res3.kind === "escalate_to_reviewer") {
      expect(res3.roundsUsed).toBe(3);
      expect(res3.verdict.complete).toBe(false);
      expect(res3.commentBody).toContain("Лимит раундов судьи исчерпан (3/3)");
      expect(res3.commentBody).toContain("Criterion 1");
      expect(res3.commentBody).toContain("score=0.50");
      expect(res3.patch?.status).toBe("in_review");
    }

    // Attempting a 4th round does NOT execute another model call (enforce <= 3)
    const res4 = await controller.judge({
      issueId: "issue-3",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Criterion 1"],
      headSha: "sha-4",
    });
    expect(res4.kind).toBe("escalate_to_reviewer");
    if (res4.kind === "escalate_to_reviewer") {
      expect(res4.fromLedger).toBe(false);
      expect(res4.roundsUsed).toBe(3);
    }
    expect(models.calls).toBe(3); // Never exceeded 3
  });

  it("resolveMaxRounds caps at MAX_ROUNDS (<= 3)", () => {
    expect(resolveMaxRounds({ maxReviewRounds: 5, settingsMaxRounds: 10 })).toBe(3);
    expect(resolveMaxRounds({ maxReviewRounds: 2, settingsMaxRounds: 10 })).toBe(2);
    expect(resolveMaxRounds({ maxReviewRounds: null, settingsMaxRounds: null })).toBe(3);
  });

  it("formats return and escalation comments clearly", () => {
    const retComment = formatGoalJudgeReturnComment({
      verdict: {
        complete: false,
        score: 0.33,
        missing: ["missing foo", "missing bar"],
        summary: "Not done yet",
      },
      round: 1,
      maxRounds: 3,
    });
    expect(retComment).toContain("[GOAL-JUDGE]");
    expect(retComment).toContain("33%");
    expect(retComment).toContain("missing foo");
    expect(retComment).toContain("missing bar");

    const escComment = formatGoalJudgeEscalationComment({
      verdict: {
        complete: false,
        score: 0.66,
        missing: ["residual item"],
        summary: "Escalated for human check",
      },
      round: 3,
      maxRounds: 3,
    });
    expect(escComment).toContain("[GOAL-JUDGE ESCALATION]");
    expect(escComment).toContain("3/3");
    expect(escComment).toContain("residual item");
  });

  it("shared/persisted ledger preserves rounds across separate controller instances", async () => {
    const sharedLedger = createInMemoryGoalJudgeLedger();
    const models = fakeModelPort([
      { score: 0.3, missing: ["Crit A"], complete: false },
      { score: 0.6, missing: ["Crit B"], complete: false },
      { score: 0.8, missing: ["Crit C"], complete: false },
    ]);

    // Controller 1 (e.g. first sweep worker / pass)
    const ctrl1 = createGoalJudgeRoundController({
      settings: fakeSettings(true, 3),
      models,
      ledger: sharedLedger,
    });
    const d1 = await ctrl1.judge({
      issueId: "issue-shared-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Crit A", "Crit B", "Crit C"],
      headSha: "sha-1",
    });
    expect(d1.kind).toBe("return_to_executor");
    if (d1.kind === "return_to_executor") {
      expect(d1.roundsUsed).toBe(1);
    }

    // Controller 2 (fresh instance created by goalJudgeFactory on next review pass)
    const ctrl2 = createGoalJudgeRoundController({
      settings: fakeSettings(true, 3),
      models,
      ledger: sharedLedger,
    });
    const d2 = await ctrl2.judge({
      issueId: "issue-shared-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Crit A", "Crit B", "Crit C"],
      headSha: "sha-2",
    });
    expect(d2.kind).toBe("return_to_executor");
    if (d2.kind === "return_to_executor") {
      expect(d2.roundsUsed).toBe(2);
    }

    // Controller 3 (third separate instance) reaches round 3 and escalates
    const ctrl3 = createGoalJudgeRoundController({
      settings: fakeSettings(true, 3),
      models,
      ledger: sharedLedger,
    });
    const d3 = await ctrl3.judge({
      issueId: "issue-shared-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Crit A", "Crit B", "Crit C"],
      headSha: "sha-3",
    });
    expect(d3.kind).toBe("escalate_to_reviewer");
    if (d3.kind === "escalate_to_reviewer") {
      expect(d3.roundsUsed).toBe(3);
      expect(d3.commentBody).toContain("Лимит раундов судьи исчерпан (3/3)");
      expect(d3.commentBody).toContain("Crit C");
    }

    // Controller 4 (subsequent pass) strictly respects <= 3 limit and does not call model
    const ctrl4 = createGoalJudgeRoundController({
      settings: fakeSettings(true, 3),
      models,
      ledger: sharedLedger,
    });
    const d4 = await ctrl4.judge({
      issueId: "issue-shared-1",
      companyId: "comp-1",
      status: "in_review",
      criteria: ["Crit A", "Crit B", "Crit C"],
      headSha: "sha-4",
    });
    expect(d4.kind).toBe("escalate_to_reviewer");
    expect(models.calls).toBe(3);
  });
});
