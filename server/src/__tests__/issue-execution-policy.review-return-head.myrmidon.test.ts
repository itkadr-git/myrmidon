import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@myrmidon/shared";

// myrmidon(OPE-11970): the execution state remembers the pull request head of
// the last return (`lastChangesRequestedHeadSha`). The review-return guard
// compares it with the head of the next return: equal heads mean no commit was
// made in between and the executor is not woken again. The mark must therefore
// survive the executor's resubmission and the reviewer's next return, and must
// be gone once the stage is approved.

const engineerAgentId = "11111111-1111-4111-8111-111111111111";
const reviewerAgentId = "22222222-2222-4222-8222-222222222222";
const stageId = "98fe3cd5-ce3b-4aed-9c0f-855fa2405ca5";
const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const policy = normalizeIssueExecutionPolicy({
  stages: [
    {
      id: stageId,
      type: "review",
      participants: [{ type: "agent", agentId: reviewerAgentId }],
    },
  ],
})!;

function state(
  status: "pending" | "changes_requested",
  head: string | null,
): IssueExecutionState {
  return {
    status,
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: engineerAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: status === "changes_requested" ? "changes_requested" : null,
    monitor: null,
    changesRequestedCount: 1,
    ...(head ? { lastChangesRequestedHeadSha: head } : {}),
  };
}

describe("lastChangesRequestedHeadSha in the execution state", () => {
  it("survives the executor's resubmission", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: engineerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: state("changes_requested", HEAD_A),
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: engineerAgentId },
      commentBody: "Nothing to change, the failing checks are infrastructure",
    });

    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      lastChangesRequestedHeadSha: HEAD_A,
    });
  });

  it("is still there when the reviewer returns the task again", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: state("pending", HEAD_A),
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "REQUEST CHANGES: CI is still red on this head",
    });

    expect(result.decision).toMatchObject({ outcome: "changes_requested" });
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      lastChangesRequestedHeadSha: HEAD_A,
    });
  });

  it("is gone once the reviewer approves the stage", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: state("pending", HEAD_A),
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: reviewerAgentId },
      commentBody: "APPROVE: CI is green on the exact head",
    });

    expect(result.decision).toMatchObject({ outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({ status: "completed" });
    expect(result.patch.executionState).not.toHaveProperty("lastChangesRequestedHeadSha");
  });

  it("is not invented for a state that never had a return", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: engineerAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: state("changes_requested", null),
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: engineerAgentId },
      commentBody: "Fixed",
    });

    expect(result.patch.executionState).toMatchObject({ status: "pending" });
    expect(result.patch.executionState).not.toHaveProperty("lastChangesRequestedHeadSha");
  });
});

describe("parseIssueExecutionState and lastChangesRequestedHeadSha", () => {
  it("keeps the mark when it is stored", () => {
    expect(parseIssueExecutionState(state("changes_requested", HEAD_A))?.lastChangesRequestedHeadSha).toBe(HEAD_A);
  });

  it("does not add the mark to a state stored without it", () => {
    const parsed = parseIssueExecutionState(state("changes_requested", null));

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("lastChangesRequestedHeadSha");
  });
});
