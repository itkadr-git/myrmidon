import { describe, expect, it } from "vitest";
import {
  classifyIssueGraphLiveness,
  classifyIssueReviewPaths,
  type IssueGraphLivenessInput,
  type IssueLivenessIssueInput,
} from "./issue-graph-liveness.js";

// myrmidon(HUMAN-REVIEW-WAIT): a review handed to a person (reviewPolicy
// "human_only" with the assignee left on the agent) is a lawful waiting state:
// it must classify as covered, never as stalled, so no review-path-lost wake
// is armed against the executor while the human reads.

function reviewIssue(
  overrides: Partial<IssueLivenessIssueInput> = {},
): IssueLivenessIssueInput {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "CO-1",
    title: "Deck handoff",
    status: "in_review",
    assigneeAgentId: "agent-1",
    ...overrides,
  };
}

function livenessInput(
  issues: IssueLivenessIssueInput[],
): IssueGraphLivenessInput {
  return {
    issues,
    relations: [],
    agents: [
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Designer",
        role: "designer",
        status: "idle",
      },
    ],
    now: new Date("2026-10-05T20:00:00Z"),
  };
}

describe("issue review paths — human-only wait", () => {
  it("treats a human_only review policy as a maintained human reviewer path", () => {
    const input = livenessInput([
      reviewIssue({
        reviewPolicy: "human_only",
        responsibleUserId: "owner-user",
      }),
    ]);
    const paths = classifyIssueReviewPaths(input, input.issues[0]!);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "human_reviewer",
          userId: "owner-user",
          ref: "owner-user",
        }),
      ]),
    );
  });

  it("falls back to the creating user when no responsible user is set", () => {
    const input = livenessInput([
      reviewIssue({ reviewPolicy: "human_only", createdByUserId: "creator-user" }),
    ]);
    const paths = classifyIssueReviewPaths(input, input.issues[0]!);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "human_reviewer", userId: "creator-user" }),
      ]),
    );
  });

  it("still classifies a human_only review as covered when neither owner resolves", () => {
    const input = livenessInput([reviewIssue({ reviewPolicy: "human_only" })]);
    const paths = classifyIssueReviewPaths(input, input.issues[0]!);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "human_reviewer", userId: null }),
      ]),
    );
  });

  it("does not extend the wait path to other review policies", () => {
    for (const reviewPolicy of ["anyone", "not_creator", null] as const) {
      const input = livenessInput([
        reviewIssue({ reviewPolicy, responsibleUserId: "owner-user" }),
      ]);
      const paths = classifyIssueReviewPaths(input, input.issues[0]!);
      expect(paths.filter((path) => path.kind === "human_reviewer")).toHaveLength(0);
    }
  });

  it("keeps the assigneeUserId owner path winning its own fact", () => {
    const input = livenessInput([
      reviewIssue({ assigneeUserId: "assigned-user", reviewPolicy: "human_only" }),
    ]);
    const paths = classifyIssueReviewPaths(input, input.issues[0]!);
    expect(
      paths.filter((path) => path.kind === "human_reviewer"),
    ).toHaveLength(2);
  });

  it("the conversation fast path is unchanged by the policy fact", () => {
    const input = livenessInput([
      reviewIssue({
        conversationAgentId: "agent-1",
        conversationUserId: "owner-user",
        conversationState: "waiting",
        reviewPolicy: "human_only",
      }),
    ]);
    const paths = classifyIssueReviewPaths(input, input.issues[0]!);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ kind: "human_reviewer", userId: "owner-user" });
  });
});

describe("issue graph liveness — human-only wait", () => {
  it("raises in_review_without_action_path for a pathless agent-owned review", () => {
    const findings = classifyIssueGraphLiveness(livenessInput([reviewIssue()]));
    expect(findings.map((finding) => finding.state)).toContain(
      "in_review_without_action_path",
    );
  });

  it("does not raise a review finding when the review waits on a person", () => {
    const findings = classifyIssueGraphLiveness(
      livenessInput([
        reviewIssue({ reviewPolicy: "human_only", responsibleUserId: "owner-user" }),
      ]),
    );
    expect(findings).toHaveLength(0);
  });
});
