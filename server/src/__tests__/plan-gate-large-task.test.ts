import { describe, expect, it } from "vitest";
import { hasLargeSizeLabel, isLargeEngineeringTask } from "../myrmidon/plan-gate/large-task.js";
import { buildPaperclipTaskMarkdown, buildReviewerInputFromTaskData } from "../services/heartbeat.js";

describe("plan-gate large task detection and directives", () => {
  it("detects size:M and size:L labels", () => {
    expect(hasLargeSizeLabel(["bug", "size:m"])).toBe(true);
    expect(hasLargeSizeLabel(["feature", "SIZE:L"])).toBe(true);
    expect(hasLargeSizeLabel(["size:s", "size:xs"])).toBe(false);
    expect(hasLargeSizeLabel([])).toBe(false);
  });

  it("identifies large engineering task for engineering agents", () => {
    expect(
      isLargeEngineeringTask({
        agentName: "adm-dev-eng-1",
        labelNames: ["size:M"],
      }),
    ).toBe(true);

    expect(
      isLargeEngineeringTask({
        agentName: "adm-dev-eng-1",
        labelNames: ["size:S"],
      }),
    ).toBe(false);

    expect(
      isLargeEngineeringTask({
        agentName: "adm-pm-1",
        labelNames: ["size:L"],
      }),
    ).toBe(false);
  });

  it("includes 'Make the plan only' directive in planning mode", () => {
    const prompt = buildPaperclipTaskMarkdown({
      issue: {
        id: "task-1",
        identifier: "OPE-100",
        title: "Large Task",
        workMode: "planning",
        description: "Task description",
      },
    });

    expect(prompt).toContain("- Work mode: \"planning\"");
    expect(prompt).toContain("Make the plan only. Do not write code or perform implementation work.");
  });

  it("instructs reviewer to verify plan invariants when taskPlan is present", () => {
    const issue = {
      id: "issue-1",
      identifier: "OPE-100",
      title: "Task Title",
      description: "Description",
    };
    const pullRequest = {
      number: 123,
      repository: "itkadr-git/myrmidon",
      baseBranch: "main",
      headBranch: "bot/OPE-100",
      headSha: "abc1234",
    };
    const reviewerInput = buildReviewerInputFromTaskData({ issue, pullRequest });
    const prompt = buildPaperclipTaskMarkdown({
      issue: { ...issue, status: "in_review", workMode: "standard" },
      reviewerInput,
      taskPlan: {
        documentId: "doc-1",
        revisionId: "rev-1",
        revisionNumber: 1,
        body: "### Invariants\n1. Invariant check\n2. Safety check",
      },
    });

    expect(prompt).toContain("Plan invariants verification:");
    expect(prompt).toContain("Verify that the implementation satisfies the invariants specified in the task plan document.");
  });
});
