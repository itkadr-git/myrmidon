import { describe, expect, it } from "vitest";
import {
  REVIEW_CI_WAIT_MAX_ATTEMPTS,
  REVIEW_DECISION_MAX_REWAKES,
  REVIEW_DECISION_RECOVERY_INSTRUCTION,
  countStalledReviewDeferrals,
  decideStalledReviewRecovery,
  pullRequestHeadCiStateFromChecks,
  selectOpenPullRequestWorkProduct,
} from "./policy.js";
import {
  buildReviewApprovalPendingMergeNotice,
  isApprovalRequestingDone,
} from "./pre-merge-approval.js";

// myrmidon(OPE-10045): the pure half of the review-stage recovery.

describe("decideStalledReviewRecovery", () => {
  it("waits for CI while the PR head CI is pending", () => {
    expect(decideStalledReviewRecovery({ ci: "pending", ciWaitsUsed: 0, decisionRewakesUsed: 1 })).toEqual({
      kind: "wait_for_ci",
      attempt: 1,
      maxAttempts: REVIEW_CI_WAIT_MAX_ATTEMPTS,
    });
  });

  it("does not count CI waits as decision re-wakes", () => {
    expect(
      decideStalledReviewRecovery({ ci: "pending", ciWaitsUsed: 5, decisionRewakesUsed: REVIEW_DECISION_MAX_REWAKES }),
    ).toMatchObject({ kind: "wait_for_ci", attempt: 6 });
  });

  it("asks for the decision once more when CI is finished", () => {
    expect(decideStalledReviewRecovery({ ci: "complete", ciWaitsUsed: 3, decisionRewakesUsed: 1 })).toEqual({
      kind: "retry_decision",
      attempt: 2,
      maxAttempts: REVIEW_DECISION_MAX_REWAKES,
    });
  });

  it("asks for the decision when the CI state cannot be read or there is no PR", () => {
    expect(decideStalledReviewRecovery({ ci: "unknown", ciWaitsUsed: 0, decisionRewakesUsed: 1 }).kind).toBe(
      "retry_decision",
    );
    expect(decideStalledReviewRecovery({ ci: "no_pull_request", ciWaitsUsed: 0, decisionRewakesUsed: 1 }).kind).toBe(
      "retry_decision",
    );
  });

  it("escalates after two decision re-wakes", () => {
    expect(decideStalledReviewRecovery({ ci: "complete", ciWaitsUsed: 0, decisionRewakesUsed: 2 })).toEqual({
      kind: "escalate",
      reason: "decision_retries_exhausted",
    });
  });

  it("stops waiting for CI after the bounded number of waits", () => {
    expect(
      decideStalledReviewRecovery({
        ci: "pending",
        ciWaitsUsed: REVIEW_CI_WAIT_MAX_ATTEMPTS,
        decisionRewakesUsed: 1,
      }),
    ).toMatchObject({ kind: "retry_decision" });
    expect(
      decideStalledReviewRecovery({
        ci: "pending",
        ciWaitsUsed: REVIEW_CI_WAIT_MAX_ATTEMPTS,
        decisionRewakesUsed: 2,
      }),
    ).toEqual({ kind: "escalate", reason: "ci_wait_exhausted" });
  });

  it("names both decisions in the instruction", () => {
    expect(REVIEW_DECISION_RECOVERY_INSTRUCTION).toContain("Submit the review decision now");
    expect(REVIEW_DECISION_RECOVERY_INSTRUCTION).toContain("status=in_progress");
    expect(REVIEW_DECISION_RECOVERY_INSTRUCTION).toContain("status=done");
  });
});

describe("countStalledReviewDeferrals", () => {
  it("counts only the rows of the same stage", () => {
    expect(
      countStalledReviewDeferrals(
        [
          { details: { kind: "ci_wait", stageId: "stage-1" } },
          { details: { kind: "ci_wait", stageId: "stage-1" } },
          { details: { kind: "decision_retry", stageId: "stage-1" } },
          { details: { kind: "decision_retry", stageId: "stage-2" } },
          { details: null },
        ],
        "stage-1",
      ),
    ).toEqual({ ciWaits: 2, decisionRetries: 1 });
  });
});

describe("pullRequestHeadCiStateFromChecks", () => {
  it("is pending while a check run is queued or in progress", () => {
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ status: "completed", conclusion: "success" }, { status: "queued" }],
        combinedStatus: { state: "success", statuses: [] },
      }),
    ).toBe("pending");
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ status: "in_progress" }],
        combinedStatus: { state: "success", statuses: [] },
      }),
    ).toBe("pending");
  });

  it("is pending while a commit status is pending", () => {
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [],
        combinedStatus: { state: "pending", statuses: [{ context: "ci", state: "pending" }] },
      }),
    ).toBe("pending");
  });

  it("is complete when every check finished, whatever the conclusion", () => {
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [
          { status: "completed", conclusion: "failure" },
          { status: "completed", conclusion: "cancelled" },
        ],
        // GitHub answers "pending" with no statuses when a commit has no status contexts.
        combinedStatus: { state: "pending", statuses: [] },
      }),
    ).toBe("complete");
  });

  it("is unknown when a read failed", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: null, combinedStatus: { state: "success" } })).toBe(
      "unknown",
    );
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [], combinedStatus: null })).toBe("unknown");
  });
});

describe("selectOpenPullRequestWorkProduct", () => {
  it("prefers the open primary pull request and ignores merged, closed and archived ones", () => {
    const products = [
      { id: "merged", type: "pull_request", status: "merged", isPrimary: true, updatedAt: new Date("2026-10-30T10:00:00Z") },
      { id: "old-open", type: "pull_request", status: "open", isPrimary: false, updatedAt: new Date("2026-10-29T10:00:00Z") },
      { id: "new-open", type: "pull_request", status: "ready_for_review", isPrimary: false, updatedAt: new Date("2026-10-30T09:00:00Z") },
      { id: "archived", type: "pull_request", status: "archived", isPrimary: false, updatedAt: new Date("2026-10-30T11:00:00Z") },
      { id: "branch", type: "branch", status: "active", isPrimary: false, updatedAt: new Date("2026-10-30T12:00:00Z") },
    ];
    expect(selectOpenPullRequestWorkProduct(products)?.id).toBe("new-open");
    expect(
      selectOpenPullRequestWorkProduct([
        ...products,
        { id: "primary-open", type: "pull_request", status: "open", isPrimary: true, updatedAt: new Date("2026-10-01T00:00:00Z") },
      ])?.id,
    ).toBe("primary-open");
    expect(selectOpenPullRequestWorkProduct(products.filter((product) => product.status === "merged"))).toBeNull();
  });
});

describe("pre-merge approval", () => {
  it("applies only to an approval that asks for done on an open issue", () => {
    expect(isApprovalRequestingDone({ decisionOutcome: "approved", requestedStatus: "done", existingStatus: "in_review" })).toBe(true);
    expect(isApprovalRequestingDone({ decisionOutcome: "approved", requestedStatus: "in_review", existingStatus: "in_review" })).toBe(false);
    expect(isApprovalRequestingDone({ decisionOutcome: "changes_requested", requestedStatus: "done", existingStatus: "in_review" })).toBe(false);
    expect(isApprovalRequestingDone({ decisionOutcome: undefined, requestedStatus: "done", existingStatus: "in_review" })).toBe(false);
    expect(isApprovalRequestingDone({ decisionOutcome: "approved", requestedStatus: "done", existingStatus: "done" })).toBe(false);
  });

  it("tells the reviewer the approval is kept until the merge", () => {
    const notice = buildReviewApprovalPendingMergeNotice("https://github.com/acme/app/pull/7");
    expect(notice).toMatchObject({
      code: "review_approval_pending_merge",
      recorded: true,
      pendingMerge: true,
      pullRequestUrl: "https://github.com/acme/app/pull/7",
    });
    expect(notice.message).toContain("Одобрение записано, задача закроется после слияния");
  });
});
