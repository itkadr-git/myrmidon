// myrmidon(REVIEW-ROUTING): the pure decisions — who needs a reviewer, who may
// be picked, and what the stage patches look like (built through the vendor's
// own execution-policy transition, so the review flow accepts them).

import { describe, expect, it } from "vitest";
import {
  buildReviewRoutingAssignPatch,
  buildReviewRoutingReassignPatch,
  buildReviewRoutingWakeContext,
  excludedReviewerIds,
  hoursSince,
  isReviewOverdue,
  issueNeedsReviewer,
  pickReviewer,
  readPendingAgentReview,
  type RoutingIssue,
} from "./policy.js";

const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNEE = "aaaaaaaa-0000-4000-8000-000000000002";
const REV_A = "bbbbbbbb-0000-4000-8000-000000000001";
const REV_B = "bbbbbbbb-0000-4000-8000-000000000002";

function issue(overrides: Partial<RoutingIssue> = {}): RoutingIssue {
  return {
    id: "issue-1",
    status: "in_review",
    assigneeAgentId: ASSIGNEE,
    assigneeUserId: null,
    createdByAgentId: AUTHOR,
    createdByUserId: null,
    executionPolicy: null,
    executionState: null,
    ...overrides,
  };
}

describe("issueNeedsReviewer", () => {
  it("is true for an in_review task with no policy and no state", () => {
    expect(issueNeedsReviewer(issue())).toBe(true);
  });

  it("is false outside review", () => {
    expect(issueNeedsReviewer(issue({ status: "in_progress" }))).toBe(false);
    expect(issueNeedsReviewer(issue({ status: "done" }))).toBe(false);
  });

  it("is false when a stage already has a participant", () => {
    const policy = { stages: [{ id: "s", type: "review", participants: [{ type: "agent", agentId: REV_A }] }] };
    expect(issueNeedsReviewer(issue({ executionPolicy: policy }))).toBe(false);
  });

  it("is true for a policy with no stages and an idle state, and keeps nothing else in the way", () => {
    expect(
      issueNeedsReviewer(issue({ executionPolicy: { mode: "normal", stages: [] }, executionState: { status: "idle" } })),
    ).toBe(true);
  });

  it("leaves a workflow in flight or a monitor alone", () => {
    expect(issueNeedsReviewer(issue({ executionState: { status: "pending" } }))).toBe(false);
    expect(issueNeedsReviewer(issue({ executionState: { status: "idle", monitor: { status: "cleared" } } }))).toBe(false);
  });

  it("myrmidon(HUMAN-REVIEW-WAIT): never routes a human-only wait to an agent reviewer", () => {
    expect(issueNeedsReviewer(issue({ reviewPolicy: "human_only", responsibleUserId: "owner" }))).toBe(false);
    // other policies do not declare a human wait — routing stays available
    expect(issueNeedsReviewer(issue({ reviewPolicy: "anyone" }))).toBe(true);
    expect(issueNeedsReviewer(issue({ reviewPolicy: "not_creator" }))).toBe(true);
  });
});

describe("pickReviewer", () => {
  const candidates = [
    { id: REV_B, role: "reviewer", load: 1 },
    { id: REV_A, role: "reviewer", load: 1 },
    { id: AUTHOR, role: "reviewer", load: 0 },
    { id: ASSIGNEE, role: "reviewer", load: 0 },
    { id: "cccccccc-0000-4000-8000-000000000001", role: "reviewer", load: 4 },
  ];

  it("picks the least loaded, never the author or the assignee", () => {
    const picked = pickReviewer({ candidates, excluded: excludedReviewerIds(issue()), maxLoad: 5 });
    expect(picked?.id).toBe(REV_A);
  });

  it("breaks ties by id so the choice is deterministic", () => {
    const picked = pickReviewer({ candidates, excluded: excludedReviewerIds(issue()), maxLoad: 5 });
    const again = pickReviewer({ candidates: [...candidates].reverse(), excluded: excludedReviewerIds(issue()), maxLoad: 5 });
    expect(again?.id).toBe(picked?.id);
  });

  it("skips reviewers at the load ceiling", () => {
    const picked = pickReviewer({ candidates, excluded: excludedReviewerIds(issue()), maxLoad: 2 });
    expect(picked?.id).toBe(REV_A);
    expect(pickReviewer({ candidates, excluded: excludedReviewerIds(issue()), maxLoad: 1 })).toBeNull();
  });

  it("returns null when nobody is eligible", () => {
    expect(pickReviewer({ candidates: [], excluded: new Set(), maxLoad: 5 })).toBeNull();
    expect(
      pickReviewer({ candidates: [{ id: AUTHOR, role: "reviewer", load: 0 }], excluded: excludedReviewerIds(issue()), maxLoad: 5 }),
    ).toBeNull();
  });
});

describe("overdue", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  it("counts whole hours", () => {
    expect(hoursSince(new Date("2026-01-01T09:30:00Z"), now)).toBe(26);
    expect(hoursSince(new Date("2026-01-03T00:00:00Z"), now)).toBe(0);
  });
  it("is overdue at the threshold, never when disabled", () => {
    const since = new Date("2026-01-01T12:00:00Z");
    expect(isReviewOverdue({ since, now, afterHours: 24 })).toBe(true);
    expect(isReviewOverdue({ since, now, afterHours: 25 })).toBe(false);
    expect(isReviewOverdue({ since, now, afterHours: 0 })).toBe(false);
  });
});

describe("buildReviewRoutingAssignPatch", () => {
  it("creates a pending one-stage review through the vendor transition", () => {
    const patch = buildReviewRoutingAssignPatch({ issue: issue(), reviewerAgentId: REV_A });
    expect(patch.status).toBe("in_review");
    expect(patch.assigneeAgentId).toBe(REV_A);
    const policy = patch.executionPolicy as { stages: Array<{ type: string; participants: Array<{ agentId: string }> }> };
    expect(policy.stages).toHaveLength(1);
    expect(policy.stages[0]?.type).toBe("review");
    expect(policy.stages[0]?.participants.map((p) => p.agentId)).toEqual([REV_A]);
    const state = patch.executionState as Record<string, any>;
    expect(state.status).toBe("pending");
    expect(state.currentParticipant).toMatchObject({ type: "agent", agentId: REV_A });
    expect(state.returnAssignee).toMatchObject({ type: "agent", agentId: ASSIGNEE });
    expect(state.currentStageId).toBe((policy.stages[0] as any).id);
  });

  it("keeps the fields of an existing stage-less policy", () => {
    const patch = buildReviewRoutingAssignPatch({
      issue: issue({ executionPolicy: { mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 7 } }),
      reviewerAgentId: REV_A,
    });
    expect(patch.executionPolicy).toMatchObject({ commentRequired: true, maxReviewRounds: 7 });
  });

  it("falls back to the author as the return assignee when the task has no assignee", () => {
    const patch = buildReviewRoutingAssignPatch({
      issue: issue({ assigneeAgentId: null }),
      reviewerAgentId: REV_A,
    });
    expect((patch.executionState as Record<string, any>).returnAssignee).toMatchObject({ agentId: AUTHOR });
  });
});

describe("pending review and reassignment", () => {
  function pendingIssue(): RoutingIssue {
    const patch = buildReviewRoutingAssignPatch({ issue: issue(), reviewerAgentId: REV_A });
    return issue({
      assigneeAgentId: REV_A,
      executionPolicy: patch.executionPolicy,
      executionState: patch.executionState,
    });
  }

  it("reads the pending agent review", () => {
    expect(readPendingAgentReview(pendingIssue())).toMatchObject({
      reviewerAgentId: REV_A,
      returnAssigneeAgentId: ASSIGNEE,
    });
    expect(readPendingAgentReview(issue())).toBeNull();
  });

  it("moves the stage to another reviewer and keeps the stage id, rounds and return assignee", () => {
    const before = pendingIssue();
    const patch = buildReviewRoutingReassignPatch({ issue: before, newReviewerAgentId: REV_B });
    expect(patch).not.toBeNull();
    expect(patch!.assigneeAgentId).toBe(REV_B);
    const state = patch!.executionState as Record<string, any>;
    const prior = before.executionState as Record<string, any>;
    expect(state.currentParticipant).toMatchObject({ agentId: REV_B });
    expect(state.currentStageId).toBe(prior.currentStageId);
    expect(state.returnAssignee).toEqual(prior.returnAssignee);
    const policy = patch!.executionPolicy as { stages: Array<{ participants: Array<{ agentId: string }> }> };
    expect(policy.stages[0]?.participants.map((p) => p.agentId)).toEqual([REV_B]);
  });

  it("builds nothing for a task with no pending agent review", () => {
    expect(buildReviewRoutingReassignPatch({ issue: issue(), newReviewerAgentId: REV_B })).toBeNull();
  });

  it("builds the reviewer wake context from the persisted state", () => {
    const state = pendingIssue().executionState as Record<string, unknown>;
    expect(buildReviewRoutingWakeContext(state)).toMatchObject({
      wakeRole: "reviewer",
      stageType: "review",
      allowedActions: ["approve", "request_changes"],
    });
  });
});
