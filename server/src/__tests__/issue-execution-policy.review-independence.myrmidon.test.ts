import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@myrmidon/shared";

// myrmidon(OPE-12231): REVIEW-INDEPENDENCE — the reviewer of a review stage
// must never be the executor of the work under review. The participant
// selection used to exclude only the return assignee, so a fresh submission
// (`done` or `in_review`) with no persisted return assignee could select the
// submitting executor from the stage roster — self-review of one's own work.
// The executor (issue assignee / submitting actor) is now excluded from the
// review-stage selection as well, while the review-return-head and
// review-stage-restart semantics stay intact.

const engineerAgentId = "11111111-1111-4111-8111-111111111111";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const otherReviewerAgentId = "33333333-3333-4333-8333-333333333333";
const boardUserId = "board-user";
const stageId = "98fe3cd5-ce3b-4aed-9c0f-855fa2405ca5";

function reviewPolicy(participantAgentIds: string[]) {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        id: stageId,
        type: "review",
        participants: participantAgentIds.map((agentId) => ({ type: "agent", agentId })),
      },
    ],
  })!;
}

function baseIssue(overrides: Record<string, unknown> = {}) {
  return {
    status: "in_progress",
    assigneeAgentId: engineerAgentId as string | null,
    assigneeUserId: null,
    executionPolicy: null as unknown,
    executionState: null as unknown,
    ...overrides,
  };
}

describe("review stage selection never picks the executor (OPE-12231)", () => {
  it("rejects a fresh in_review submission when the only reviewer candidate is the submitting executor", () => {
    const policy = reviewPolicy([engineerAgentId]);

    const call = () =>
      applyIssueExecutionPolicyTransition({
        issue: baseIssue({ executionPolicy: policy }),
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: engineerAgentId },
        commentBody: "Resubmitting for review",
      });

    // No eligible reviewer: self-assignment of the review must not happen.
    expect(call).toThrow(/No eligible review participant/);
  });

  it("picks the other roster member over the submitting executor on a fresh in_review submission", () => {
    const policy = reviewPolicy([reviewerAgentId, engineerAgentId]);

    const result = applyIssueExecutionPolicyTransition({
      issue: baseIssue({ executionPolicy: policy }),
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: engineerAgentId },
      commentBody: "Resubmitting for review",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      // The assignee is in the reviewer roster; safeReturnAssignee deliberately
      // avoids recording a reviewer as the executor return destination.
      returnAssignee: null,
    });
  });

  it("resubmission after changes requested keeps the review with a non-executor reviewer", () => {
    const policy = reviewPolicy([reviewerAgentId]);
    const state: IssueExecutionState = {
      status: "changes_requested",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      monitor: null,
      changesRequestedCount: 1,
    };

    const result = applyIssueExecutionPolicyTransition({
      issue: baseIssue({ executionPolicy: policy, executionState: state }),
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: engineerAgentId },
      commentBody: "Addressed the findings",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
    });
  });

  it("resubmission after changes requested does not hand the review back to the executor when the stage lists only the executor", () => {
    // A poisoned pending/changes_requested state left by an earlier version
    // must not resurrect the executor as its own reviewer either.
    const policy = reviewPolicy([engineerAgentId]);
    const state: IssueExecutionState = {
      status: "changes_requested",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: engineerAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      monitor: null,
      changesRequestedCount: 1,
    };

    const call = () =>
      applyIssueExecutionPolicyTransition({
        issue: baseIssue({ executionPolicy: policy, executionState: state }),
        policy,
        requestedStatus: "in_review",
        requestedAssigneePatch: {},
        actor: { agentId: engineerAgentId },
        commentBody: "Addressed the findings",
      });

    expect(call).toThrow(/No eligible review participant/);
  });

  it("a board-driven review restart still keeps the previous reviewer even though the board actor is a user", () => {
    const policy = reviewPolicy([reviewerAgentId]);
    const state: IssueExecutionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: null,
      changesRequestedCount: 0,
    };

    const result = applyIssueExecutionPolicyTransition({
      issue: baseIssue({ status: "blocked", executionPolicy: policy, executionState: state }),
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId },
    });
  });

  it("a done submission with a reviewer-only roster still routes to the reviewer, not the executor", () => {
    const policy = reviewPolicy([reviewerAgentId]);

    const result = applyIssueExecutionPolicyTransition({
      issue: baseIssue({ executionPolicy: policy }),
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: engineerAgentId },
      commentBody: "Implemented the feature",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId },
    });
  });
});
