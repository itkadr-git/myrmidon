import { describe, expect, it } from "vitest";
import { shouldCancelNotStartedHolderOnReassignment } from "./reassignment-queued-holder.js";

const OLD = "agent-old";
const NEW = "agent-new";

describe("shouldCancelNotStartedHolderOnReassignment (OPE-13097)", () => {
  const issue = { status: "in_progress", assigneeAgentId: OLD, executionState: null };

  it("cancels a queued run of the previous assignee", () => {
    expect(shouldCancelNotStartedHolderOnReassignment(issue, { id: "r", agentId: OLD, status: "queued" })).toBe(true);
  });

  it("cancels a scheduled_retry run of the previous assignee", () => {
    expect(shouldCancelNotStartedHolderOnReassignment(issue, { id: "r", agentId: OLD, status: "scheduled_retry" })).toBe(true);
  });

  it("leaves a running run alone", () => {
    expect(shouldCancelNotStartedHolderOnReassignment(issue, { id: "r", agentId: OLD, status: "running" })).toBe(false);
  });

  it("leaves a run of another agent alone", () => {
    expect(shouldCancelNotStartedHolderOnReassignment(issue, { id: "r", agentId: NEW, status: "queued" })).toBe(false);
  });

  it("returns false without a run or without a previous assignee", () => {
    expect(shouldCancelNotStartedHolderOnReassignment(issue, null)).toBe(false);
    expect(
      shouldCancelNotStartedHolderOnReassignment({ ...issue, assigneeAgentId: null }, { id: "r", agentId: OLD, status: "queued" }),
    ).toBe(false);
  });

  it("keeps the run of the current review-stage participant", () => {
    const reviewIssue = {
      status: "in_review",
      assigneeAgentId: OLD,
      executionState: { currentParticipant: { type: "agent", agentId: OLD } },
    };
    expect(shouldCancelNotStartedHolderOnReassignment(reviewIssue, { id: "r", agentId: OLD, status: "queued" })).toBe(false);
  });

  it("cancels in in_review when the run's agent is not the current participant", () => {
    const reviewIssue = {
      status: "in_review",
      assigneeAgentId: OLD,
      executionState: { currentParticipant: { type: "agent", agentId: "someone-else" } },
    };
    expect(shouldCancelNotStartedHolderOnReassignment(reviewIssue, { id: "r", agentId: OLD, status: "queued" })).toBe(true);
  });
});
