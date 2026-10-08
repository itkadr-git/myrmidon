// myrmidon(REVIEW-ROUTING): the pure decisions — who needs a reviewer, who may
// be picked, and what the stage patches look like (built through the vendor's
// own execution-policy transition, so the review flow accepts them). The PR
// lane's decisions (pr-policy.ts, pickPrReviewer) ride here too.

import { describe, expect, it } from "vitest";
import {
  buildPrRoutingTaskPatch,
  buildReviewRoutingAssignPatch,
  buildReviewRoutingReassignPatch,
  buildReviewRoutingWakeContext,
  excludedReviewerIds,
  hoursSince,
  isReviewOverdue,
  issueNeedsReviewer,
  pickPrReviewer,
  pickReviewer,
  readPendingAgentReview,
  type RoutingIssue,
} from "./policy.js";
import {
  prReviewTaskTitle,
  prRoutingCoverageKey,
  prRoutingTaskDescription,
  prStewardTaskTitle,
  prTaskIsSuperseded,
  reviewTaskDueForHead,
  readPrRoutingWorkProduct,
  stewardTaskDueForHead,
  type PullRequestHeadState,
} from "./pr-policy.js";

const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNEE = "aaaaaaaa-0000-4000-8000-000000000002";
const REV_A = "bbbbbbbb-0000-4000-8000-000000000001";
const REV_B = "bbbbbbbb-0000-4000-8000-000000000002";

function head(overrides: Partial<PullRequestHeadState> = {}): PullRequestHeadState {
  return {
    repository: "acme/widgets",
    number: 7,
    open: true,
    draft: false,
    headSha: "aaaaaaaa",
    ci: "green",
    reviewDecision: null,
    fetchFailed: false,
    ...overrides,
  };
}

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

describe("pickPrReviewer", () => {
  const reviewers = [
    { id: REV_A, role: "reviewer", load: 0 },
    { id: REV_B, role: "reviewer", load: 0 },
    { id: "cccccccc-0000-4000-8000-000000000001", role: "reviewer", load: 0 },
  ];

  it("skips the PR author's linked agent even at zero load", () => {
    const picked = pickPrReviewer({
      reviewers,
      boardLoadByAgent: new Map(),
      openPrLoadByAgent: new Map(),
      excluded: new Set([REV_A]),
      maxLoadPerReviewer: 5,
      maxOpenReviewsPerReviewer: 3,
    });
    expect(picked?.id).toBe(REV_B);
  });

  it("applies the open pr-review ceiling separately from the board ceiling", () => {
    // REV_B is at the lane ceiling though its board load is zero.
    const picked = pickPrReviewer({
      reviewers,
      boardLoadByAgent: new Map([[REV_B, 0]]),
      openPrLoadByAgent: new Map([[REV_B, 3]]),
      excluded: new Set(),
      maxLoadPerReviewer: 5,
      maxOpenReviewsPerReviewer: 3,
    });
    expect(picked?.id).toBe(REV_A);
    // REV_A is under the lane ceiling but at the board ceiling.
    const none = pickPrReviewer({
      reviewers,
      boardLoadByAgent: new Map([[REV_A, 5]]),
      openPrLoadByAgent: new Map([[REV_B, 3]]),
      excluded: new Set(),
      maxLoadPerReviewer: 5,
      maxOpenReviewsPerReviewer: 3,
    });
    expect(none?.id).toBe("cccccccc-0000-4000-8000-000000000001");
  });

  it("ranks by the combined load and returns null when every gate blocks", () => {
    // REV_A: 1 board + 1 open = 2; REV_B: 0 + 1 = 1 → least combined load wins.
    const picked = pickPrReviewer({
      reviewers,
      boardLoadByAgent: new Map([[REV_A, 1]]),
      openPrLoadByAgent: new Map([[REV_A, 1], [REV_B, 1]]),
      excluded: new Set(["cccccccc-0000-4000-8000-000000000001"]),
      maxLoadPerReviewer: 4,
      maxOpenReviewsPerReviewer: 4,
    });
    expect(picked?.id).toBe(REV_B);
    // REV_A is at the board ceiling, REV_B at the lane ceiling: nobody left.
    const none = pickPrReviewer({
      reviewers,
      boardLoadByAgent: new Map([[REV_A, 2]]),
      openPrLoadByAgent: new Map([[REV_B, 2]]),
      excluded: new Set(["cccccccc-0000-4000-8000-000000000001"]),
      maxLoadPerReviewer: 2,
      maxOpenReviewsPerReviewer: 2,
    });
    expect(none).toBeNull();
  });
});

describe("PR lane triggers (pr-policy)", () => {
  it("fires on a green head with no verdict", () => {
    expect(reviewTaskDueForHead(head())).toBe(true);
  });

  it("does not fire on drafts, closed PRs, non-green or unknown heads", () => {
    expect(reviewTaskDueForHead(head({ draft: true }))).toBe(false);
    expect(reviewTaskDueForHead(head({ open: false }))).toBe(false);
    expect(reviewTaskDueForHead(head({ ci: "not_green" }))).toBe(false);
    expect(reviewTaskDueForHead(head({ ci: "unknown", fetchFailed: true }))).toBe(false);
  });

  it("a verdict on the current head suppresses the review task", () => {
    expect(reviewTaskDueForHead(head({ reviewDecision: "CHANGES_REQUESTED" }))).toBe(false);
    expect(reviewTaskDueForHead(head({ reviewDecision: "APPROVED" }))).toBe(false);
  });

  it("a decision read for another head never reaches this check (per-head state only)", () => {
    // The resolver reports the decision for the CURRENT head; a decision that
    // predates the latest push comes back as null for the new head, so the
    // trigger fires again on the new green head.
    expect(reviewTaskDueForHead(head({ headSha: "bbbbbbbb", reviewDecision: null }))).toBe(true);
  });

  it("steward task is due only on an approved green open head", () => {
    expect(stewardTaskDueForHead(head({ reviewDecision: "APPROVED" }))).toBe(true);
    expect(stewardTaskDueForHead(head())).toBe(false);
    expect(stewardTaskDueForHead(head({ reviewDecision: "APPROVED", ci: "not_green" }))).toBe(false);
    expect(stewardTaskDueForHead(head({ reviewDecision: "APPROVED", open: false }))).toBe(false);
  });

  it("supersedes exactly when the recorded head differs from the current head", () => {
    const task = { issueId: "t", repository: "acme/widgets", number: 7, kind: "review" as const, headSha: "aaaaaaaa" };
    expect(prTaskIsSuperseded(task, "bbbbbbbb")).toBe(true);
    expect(prTaskIsSuperseded(task, "aaaaaaaa")).toBe(false);
    expect(prTaskIsSuperseded({ ...task, headSha: null }, "bbbbbbbb")).toBe(false);
  });

  it("coverage keys separate review from merge slots", () => {
    expect(prRoutingCoverageKey({ repository: "acme/widgets", number: 7, kind: "review" })).toBe("acme/widgets#7:review");
    expect(prRoutingCoverageKey({ repository: "acme/widgets", number: 7, kind: "merge" })).toBe("acme/widgets#7:merge");
  });

  it("reads the routing contract off pull_request work products only", () => {
    const wp = {
      type: "pull_request",
      metadata: { repo: "acme/widgets", number: 7, prRoutingHeadSha: "aaaaaaaa", prRoutingKind: "review" },
    };
    expect(readPrRoutingWorkProduct(wp)).toMatchObject({ repository: "acme/widgets", number: 7, kind: "review", headSha: "aaaaaaaa" });
    expect(readPrRoutingWorkProduct({ ...wp, type: "document" })).toBeNull();
    expect(readPrRoutingWorkProduct({ type: "pull_request", metadata: { repo: "acme/widgets", number: 7 } })).toBeNull();
    expect(
      readPrRoutingWorkProduct({ type: "pull_request", metadata: { ...wp.metadata, prRoutingKind: "other" } }),
    ).toBeNull();
  });

  it("names and describes the created tasks", () => {
    const long = "x".repeat(120);
    expect(prReviewTaskTitle(head({ title: long }))).toBe(`Review PR acme/widgets#7: ${"x".repeat(80)}`);
    expect(prStewardTaskTitle(head())).toBe("Merge PR acme/widgets#7");
    const desc = prRoutingTaskDescription(
      head({ url: "https://github.com/acme/widgets/pull/7", authorLogin: "agent-a", baseRef: "main" }),
      "review",
    );
    expect(desc).toContain("https://github.com/acme/widgets/pull/7");
    expect(desc).toContain("Head: aaaaaaaa");
    expect(desc).toContain("Author: agent-a");
    expect(desc).toContain("Base: main");
    expect(desc).toContain("automatic PR review routing — green head without a review verdict");
  });
});

describe("buildPrRoutingTaskPatch", () => {
  it("gives a fresh PR task the routed review-stage shape and a pending state", () => {
    const patch = buildPrRoutingTaskPatch({ reviewerAgentId: REV_A });
    expect(patch.assigneeAgentId).toBe(REV_A);
    const policy = patch.executionPolicy as { stages: Array<{ type: string; participants: Array<{ agentId: string }> }> };
    expect(policy.stages).toHaveLength(1);
    expect(policy.stages[0]?.type).toBe("review");
    expect(policy.stages[0]?.participants.map((p) => p.agentId)).toEqual([REV_A]);
    const state = patch.executionState as Record<string, any>;
    expect(state.status).toBe("pending");
    expect(state.currentParticipant).toMatchObject({ type: "agent", agentId: REV_A });
    expect(state.currentStageId).toBe((policy.stages[0] as any).id);
  });
});
