import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@myrmidon/shared";

// myrmidon(OPE-10045): returning a blocked review task to `in_review` must
// leave it with a pending review stage and a participant who can decide.
// On the board the operator re-sent the execution policy with the PATCH; the
// new policy got fresh stage ids, the stored stage id no longer matched, and
// the state was cleared to `idle` while the task became `in_review` — nobody
// could record a decision any more.

const engineerAgentId = "11111111-1111-4111-8111-111111111111";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const otherReviewerAgentId = "33333333-3333-4333-8333-333333333333";
const boardUserId = "board-user";
const oldStageId = "98fe3cd5-ce3b-4aed-9c0f-855fa2405ca5";

function reviewPolicy(participantAgentIds: string[], stageId?: string) {
  return normalizeIssueExecutionPolicy({
    stages: [
      {
        ...(stageId ? { id: stageId } : {}),
        type: "review",
        participants: participantAgentIds.map((agentId) => ({ type: "agent", agentId })),
      },
    ],
  })!;
}

function pendingReviewState(participantAgentId: string, stageId = oldStageId): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    changesRequestedCount: 0,
  };
}

describe("review stage after a recovery block", () => {
  it("starts the re-sent policy's review stage when the operator returns the task to in_review", () => {
    const previousPolicy = reviewPolicy([reviewerAgentId], oldStageId);
    // Re-sent without stage ids: normalization gives the stage a new id.
    const policy = reviewPolicy([otherReviewerAgentId]);
    expect(policy.stages[0]!.id).not.toBe(oldStageId);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "blocked",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: previousPolicy,
        executionState: pendingReviewState(reviewerAgentId),
      },
      policy,
      previousPolicy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(otherReviewerAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: policy.stages[0]!.id,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: otherReviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId },
    });
  });

  it("keeps the previous reviewer when the re-sent policy still lists it", () => {
    const previousPolicy = reviewPolicy([reviewerAgentId], oldStageId);
    const policy = reviewPolicy([otherReviewerAgentId, reviewerAgentId]);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "blocked",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: previousPolicy,
        executionState: pendingReviewState(reviewerAgentId),
      },
      policy,
      previousPolicy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });

    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId },
    });
    expect(result.patch.assigneeAgentId).toBe(reviewerAgentId);
  });

  it("keeps the pending stage, participant and return assignee when the task returns to review without a new policy", () => {
    const policy = reviewPolicy([reviewerAgentId], oldStageId);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "blocked",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pendingReviewState(reviewerAgentId),
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageId: oldStageId,
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: engineerAgentId },
    });
  });

  it("lets the kept participant approve straight from the blocked state", () => {
    const policy = reviewPolicy([reviewerAgentId], oldStageId);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "blocked",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: pendingReviewState(reviewerAgentId),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "APPROVE: checked the head, CI green.",
    });

    expect(result.decision).toMatchObject({ stageId: oldStageId, outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      lastDecisionOutcome: "approved",
    });
  });

  it("still clears a stale stage when the task leaves review", () => {
    const previousPolicy = reviewPolicy([reviewerAgentId], oldStageId);
    const policy = reviewPolicy([reviewerAgentId]);

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: previousPolicy,
        executionState: pendingReviewState(reviewerAgentId),
      },
      policy,
      previousPolicy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { userId: boardUserId },
      allowBoardOverride: true,
    });

    expect(result.patch.executionState).toBeNull();
    expect(result.patch.status).toBeUndefined();
  });
});
