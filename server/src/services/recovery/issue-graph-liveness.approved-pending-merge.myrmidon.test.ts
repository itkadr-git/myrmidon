import { describe, expect, it } from "vitest";
import {
  classifyIssueGraphLiveness,
  classifyIssueReviewPaths,
  type IssueGraphLivenessInput,
  type IssueLivenessIssueInput,
} from "./issue-graph-liveness.js";

// myrmidon(OPE-10045): a reviewer approved the last stage while the PR was
// still open. The decision is recorded and the PR sync closes the task after
// the merge, so the review is waiting on the merge, not stalled.

function reviewIssue(overrides: Partial<IssueLivenessIssueInput> = {}): IssueLivenessIssueInput {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "CO-1",
    title: "Fix the sync",
    status: "in_review",
    assigneeAgentId: "reviewer-1",
    ...overrides,
  };
}

function livenessInput(issues: IssueLivenessIssueInput[]): IssueGraphLivenessInput {
  return {
    issues,
    relations: [],
    agents: [
      { id: "reviewer-1", companyId: "company-1", name: "Reviewer", role: "reviewer", status: "idle" },
    ],
    now: new Date("2026-10-30T10:00:00Z"),
  };
}

const approvedState = {
  status: "completed",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: { type: "agent", agentId: "engineer-1", userId: null },
  completedStageIds: ["stage-1"],
  lastDecisionId: "decision-1",
  lastDecisionOutcome: "approved",
};

describe("issue review paths — approval pending merge", () => {
  it("treats an approved, completed stage as a maintained path", () => {
    const input = livenessInput([reviewIssue({ executionState: approvedState })]);
    expect(classifyIssueReviewPaths(input, input.issues[0]!)).toEqual([
      expect.objectContaining({ kind: "approved_pending_merge", ref: "decision-1" }),
    ]);
    expect(
      classifyIssueGraphLiveness(input).filter((finding) => finding.state === "in_review_without_action_path"),
    ).toEqual([]);
  });

  it("still reports an in-review issue without any path", () => {
    const input = livenessInput([reviewIssue({ executionState: null })]);
    expect(classifyIssueReviewPaths(input, input.issues[0]!)).toEqual([]);
    expect(classifyIssueGraphLiveness(input).map((finding) => finding.state)).toContain(
      "in_review_without_action_path",
    );
  });

  it("does not treat a changes-requested state as a pending merge", () => {
    const input = livenessInput([
      reviewIssue({ executionState: { ...approvedState, status: "changes_requested", lastDecisionOutcome: "changes_requested" } }),
    ]);
    expect(classifyIssueReviewPaths(input, input.issues[0]!)).toEqual([]);
  });
});
