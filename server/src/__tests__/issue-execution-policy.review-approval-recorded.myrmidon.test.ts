import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";
import type { IssueExecutionState } from "@myrmidon/shared";

// myrmidon(REVIEW-APPROVAL-RECORDED): the approval of the current participant
// of a pending review stage is a decision whatever woke the run (stage wake,
// participant recovery, operator wake, CI, pickup) and whatever the stored
// policy looks like. On 14.11 the admission monitor was armed on a stale copy
// of the policy, the stage disappeared from it, and the approval fell through
// to the PR `done` gate (HTTP 409) while the state stayed pending / went idle.

const engineerId = "11111111-1111-4111-8111-111111111111";
const reviewerId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const stageId = "98fe3cd5-ce3b-4aed-9c0f-855fa2405ca5";

const pendingState: IssueExecutionState = {
  status: "pending",
  currentStageId: stageId,
  currentStageIndex: 0,
  currentStageType: "review",
  currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
  returnAssignee: { type: "agent", agentId: engineerId, userId: null },
  reviewRequest: null,
  completedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
  monitor: null,
  changesRequestedCount: 0,
};

const monitorOnlyPolicy = () =>
  normalizeIssueExecutionPolicy({
    stages: [],
    monitor: {
      nextCheckAt: "2026-11-14T00:55:36.010Z",
      notes: "Review admission waits for the next tick's reviewer-wake quota (1 per tick).",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: "Review CI wait",
      externalRef: "282df09a-4524-41ed-9317-ccd095bb6c59",
      recoveryPolicy: "wake_owner",
    },
  });

function approve(input: { policy: ReturnType<typeof normalizeIssueExecutionPolicy>; actorId?: string; comment?: string | null }) {
  return applyIssueExecutionPolicyTransition({
    issue: {
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
      executionPolicy: input.policy,
      executionState: pendingState,
    },
    policy: input.policy,
    previousPolicy: input.policy,
    requestedStatus: "done",
    requestedAssigneePatch: {},
    actor: { agentId: input.actorId ?? reviewerId },
    commentBody: input.comment === undefined ? "APPROVE PR #3145 3dc5a98fd2b3d23c62c66e253486e18202228cbd" : input.comment,
  });
}

describe("approval of a pending review stage whose policy lost the stage", () => {
  it.each([
    ["a policy with only the admission monitor armed", monitorOnlyPolicy],
    ["no policy at all", () => null],
  ])("is recorded as an approved decision with %s", (_label, makePolicy) => {
    const result = approve({ policy: makePolicy() });
    expect(result.decision).toMatchObject({ stageId, stageType: "review", outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      currentStageId: null,
      currentParticipant: null,
      lastDecisionOutcome: "approved",
      completedStageIds: [stageId],
      returnAssignee: { type: "agent", agentId: engineerId },
    });
  });

  it("does not depend on the run that started the reviewer: the transition sees only the actor and the stored stage", () => {
    // A manual operator wake, participant recovery, CI or pickup all reach the
    // PATCH route with the same actor; none of them is an input here.
    const result = approve({ policy: monitorOnlyPolicy() });
    expect(result.decision?.outcome).toBe("approved");
  });

  it("still refuses to record a decision for an agent that is not the participant", () => {
    const result = approve({ policy: monitorOnlyPolicy(), actorId: otherId });
    expect(result.decision).toBeUndefined();
  });

  it("asks for a comment instead of silently dropping the approval", () => {
    expect(() => approve({ policy: monitorOnlyPolicy(), comment: "  " })).toThrow(/requires a comment/);
  });

  it("keeps the normal path when the stage is in the policy", () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ id: stageId, type: "review", participants: [{ type: "agent", agentId: reviewerId }] }],
    });
    expect(approve({ policy }).decision).toMatchObject({ stageId, outcome: "approved" });
  });
});

function requestChanges(input: { policy: ReturnType<typeof normalizeIssueExecutionPolicy>; actorId?: string; comment?: string | null }) {
  return applyIssueExecutionPolicyTransition({
    issue: {
      status: "in_review",
      assigneeAgentId: reviewerId,
      assigneeUserId: null,
      executionPolicy: input.policy,
      executionState: pendingState,
    },
    policy: input.policy,
    previousPolicy: input.policy,
    requestedStatus: "in_progress",
    requestedAssigneePatch: {},
    actor: { agentId: input.actorId ?? reviewerId },
    commentBody: input.comment === undefined ? "Needs rework: tests failed" : input.comment,
  });
}

describe("changes requested for a pending review stage whose policy lost the stage", () => {
  it.each([
    ["a policy with only the admission monitor armed", monitorOnlyPolicy],
    ["no policy at all", () => null],
  ])("is recorded as a changes_requested decision with %s", (_label, makePolicy) => {
    const result = requestChanges({ policy: makePolicy() });
    expect(result.decision).toMatchObject({ stageId, stageType: "review", outcome: "changes_requested" });
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      currentStageId: stageId,
      changesRequestedCount: 1,
      lastDecisionOutcome: "changes_requested",
      returnAssignee: { type: "agent", agentId: engineerId },
    });
    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(engineerId);
  });

  it("does not record a changes_requested decision if actor is not the participant", () => {
    const result = requestChanges({ policy: monitorOnlyPolicy(), actorId: otherId });
    expect(result.decision).toBeUndefined();
  });

  it("asks for a comment instead of silently dropping the changes_requested decision", () => {
    expect(() => requestChanges({ policy: monitorOnlyPolicy(), comment: "   " })).toThrow(/requires a comment/);
    expect(() => requestChanges({ policy: null, comment: "   " })).toThrow(/requires a comment/);
    expect(() => requestChanges({ policy: monitorOnlyPolicy(), comment: "" })).toThrow(/requires a comment/);
  });
});

