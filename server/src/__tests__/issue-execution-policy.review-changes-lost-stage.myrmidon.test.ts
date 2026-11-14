import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition } from "../services/issue-execution-policy.js";

describe("issue execution policy: changes requested when stage missing from policy (REVIEW-CHANGES-LOST-STAGE)", () => {
  const reviewerAgentId = "07555686-c5f7-4536-ac2b-c9ab1027e89f";
  const authorAgentId = "b7040a16-03a0-4d3c-8060-709038ccc403";

  it("records changes_requested and returns task to author when stages is empty array", () => {
    const stageId = "stage-review-1";
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: {
          mode: "normal",
          stages: [],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: authorAgentId },
          changesRequestedCount: 0,
        },
      },
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { actorType: "agent", agentId: reviewerAgentId },
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
    const stageId = "stage-review-2";
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        id: "issue-2",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: authorAgentId },
          changesRequestedCount: 1,
        },
      },
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { actorType: "agent", agentId: reviewerAgentId },
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
});
