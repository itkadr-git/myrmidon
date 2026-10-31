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

  it("waits like for a running CI when the CI state cannot be read", () => {
    // OPE-10063: an unreadable CI (no token, GitHub error) must not turn into a block.
    expect(decideStalledReviewRecovery({ ci: "unknown", ciWaitsUsed: 0, decisionRewakesUsed: 1 })).toEqual({
      kind: "wait_for_ci",
      attempt: 1,
      maxAttempts: REVIEW_CI_WAIT_MAX_ATTEMPTS,
    });
    expect(
      decideStalledReviewRecovery({ ci: "unknown", ciWaitsUsed: 7, decisionRewakesUsed: REVIEW_DECISION_MAX_REWAKES }),
    ).toMatchObject({ kind: "wait_for_ci", attempt: 8 });
  });

  it("asks for the decision when there is no PR", () => {
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
    for (const ci of ["pending", "unknown"] as const) {
      expect(
        decideStalledReviewRecovery({
          ci,
          ciWaitsUsed: REVIEW_CI_WAIT_MAX_ATTEMPTS,
          decisionRewakesUsed: 1,
        }),
      ).toMatchObject({ kind: "retry_decision" });
      expect(
        decideStalledReviewRecovery({
          ci,
          ciWaitsUsed: REVIEW_CI_WAIT_MAX_ATTEMPTS,
          decisionRewakesUsed: 2,
        }),
      ).toEqual({ kind: "escalate", reason: "ci_wait_exhausted" });
    }
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
  const done = (conclusion: string) => ({ name: "CI result", status: "completed", conclusion });

  it("is pending while the final CI result check is missing, however many other checks failed", () => {
    // OPE-8077: `checks` failed, typecheck and tests are still queued.
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [
          { name: "checks", status: "completed", conclusion: "failure" },
          { name: "typecheck + build", status: "queued" },
          { name: "tests (server 1/3)", status: "queued" },
        ],
      }),
    ).toBe("pending");
    // The release freeze gate is red on every PR while the tag CI runs.
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ name: "freeze", status: "completed", conclusion: "failure" }],
      }),
    ).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [] })).toBe("pending");
  });

  it("is pending while the final check is queued or in progress", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [{ name: "CI result", status: "queued" }] })).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [{ name: "CI result", status: "in_progress" }] })).toBe(
      "pending",
    );
  });

  it("is complete when the final check is completed, whatever the other checks do", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("success")] })).toBe("complete");
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [done("failure"), { name: "tests (other + runner)", status: "queued" }],
      }),
    ).toBe("complete");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [{ name: "CI result", status: "completed" }] })).toBe(
      "complete",
    );
  });

  it("does not take the leftovers of a superseded workflow run for a verdict", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("cancelled")] })).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("skipped")] })).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("cancelled"), done("success")] })).toBe("complete");
  });

  it("is unknown when the read failed", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: null })).toBe("unknown");
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
