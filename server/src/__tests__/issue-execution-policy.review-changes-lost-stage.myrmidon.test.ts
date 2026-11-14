import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@myrmidon/shared";

describe("issue execution policy: changes requested when stage missing from policy (REVIEW-CHANGES-LOST-STAGE)", () => {
  const reviewerAgentId = "07555686-c5f7-4536-ac2b-c9ab1027e89f";
  const authorAgentId = "b7040a16-03a0-4d3c-8060-709038ccc403";
  const stageId = "98fe3cd5-ce3b-4aed-9c0f-855fa2405ca5";

  const createPendingState = (changesRequestedCount = 0): IssueExecutionState => ({
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: authorAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    changesRequestedCount,
  });

  it("records changes_requested and returns task to author when stages is empty array", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [],
    });
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: createPendingState(0),
      },
      policy,
      previousPolicy: policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "Please fix the failing tests before re-submitting.",
    });

    expect(result.decision).toEqual({
      stageId,
      stageType: "review",
      outcome: "changes_requested",
      body: "Please fix the failing tests before re-submitting.",
    });
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(authorAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      changesRequestedCount: 1,
    });
  });

  it("records changes_requested and returns task to author when policy is null", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        id: "issue-2",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: createPendingState(1),
      },
      policy: null,
      previousPolicy: null,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "Still needs fixes.",
    });

    expect(result.decision).toEqual({
      stageId,
      stageType: "review",
      outcome: "changes_requested",
      body: "Still needs fixes.",
    });
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(authorAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      changesRequestedCount: 2,
    });
  });

  it("throws when comment is missing or whitespace with empty stages policy", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [],
    });
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          id: "issue-1",
          companyId: "company-1",
          status: "in_review",
          assigneeAgentId: reviewerAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: createPendingState(0),
        },
        policy,
        previousPolicy: policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "   ",
      }),
    ).toThrow(/requires a comment/);
  });

  it("throws when comment is missing or whitespace with null policy", () => {
    expect(() =>
      applyIssueExecutionPolicyTransition({
        issue: {
          id: "issue-2",
          companyId: "company-1",
          status: "in_review",
          assigneeAgentId: reviewerAgentId,
          assigneeUserId: null,
          executionPolicy: null,
          executionState: createPendingState(0),
        },
        policy: null,
        previousPolicy: null,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "",
      }),
    ).toThrow(/requires a comment/);
  });
});
