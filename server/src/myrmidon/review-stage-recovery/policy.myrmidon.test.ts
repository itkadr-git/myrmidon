import { describe, expect, it } from "vitest";
import {
  REVIEW_CI_WAIT_MAX_ATTEMPTS,
  REVIEW_DECISION_MAX_REWAKES,
  REVIEW_DECISION_RECOVERY_INSTRUCTION,
  countStalledReviewDeferrals,
  isMaintenanceInterruptedRun,
  decideStalledReviewRecovery,
  decideReviewAdmission,
  pullRequestHeadCiStateFromAllChecks,
  pullRequestHeadCiStateFromChecks,
  pullRequestHeadFinalCheckConclusion,
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
  const HEAD = "abc123";
  const done = (conclusion: string) => ({ name: "CI result", status: "completed", conclusion, head_sha: HEAD });

  it("is pending while the final CI result check is missing, however many other checks failed", () => {
    // OPE-8077: `checks` failed, typecheck and tests are still queued.
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [
          { name: "checks", status: "completed", conclusion: "failure" },
          { name: "typecheck + build", status: "queued" },
          { name: "tests (server 1/3)", status: "queued" },
        ],
        headSha: HEAD,
      }),
    ).toBe("pending");
    // The release freeze gate is red on every PR while the tag CI runs.
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ name: "freeze", status: "completed", conclusion: "failure" }],
        headSha: HEAD,
      }),
    ).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [], headSha: HEAD })).toBe("pending");
  });

  it("is pending while the final check is queued or in progress", () => {
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ name: "CI result", status: "queued", head_sha: HEAD }],
        headSha: HEAD,
      }),
    ).toBe("pending");
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [{ name: "CI result", status: "in_progress", head_sha: HEAD }],
        headSha: HEAD,
      }),
    ).toBe("pending");
  });

  it("is complete when the final check is completed, whatever the other checks do", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("success")], headSha: HEAD })).toBe("complete");
    expect(
      pullRequestHeadCiStateFromChecks({
        checkRuns: [done("failure"), { name: "tests (other + runner)", status: "queued" }],
        headSha: HEAD,
      }),
    ).toBe("complete");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("success")], headSha: HEAD })).toBe("complete");
  });

  it("does not take the leftovers of a superseded workflow run for a verdict", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("cancelled")], headSha: HEAD })).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("skipped")], headSha: HEAD })).toBe("pending");
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("cancelled"), done("success")], headSha: HEAD })).toBe(
      "complete",
    );
  });

  it("is unknown when the read failed", () => {
    expect(pullRequestHeadCiStateFromChecks({ checkRuns: null, headSha: HEAD })).toBe("unknown");
  });

  // OPE-12175: the review gate and the dedup key both work on the exact head
  // SHA, so a completed `CI result` of a different head must never open the
  // review.
  describe("head_sha filtering (OPE-12175)", () => {
    it("is complete when head_sha matches and the check is completed", () => {
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [done("success")], headSha: HEAD })).toBe("complete");
    });

    it("is pending when the record has a different head_sha", () => {
      const stale = { name: "CI result", status: "completed", conclusion: "success", head_sha: "deadbeef" };
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [stale], headSha: HEAD })).toBe("pending");
    });

    it("is pending when the record has no head_sha", () => {
      const noSha = { name: "CI result", status: "completed", conclusion: "success" };
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [noSha], headSha: HEAD })).toBe("pending");
    });

    it("in a mixed list only the matching record decides", () => {
      const stale = { name: "CI result", status: "completed", conclusion: "success", head_sha: "deadbeef" };
      const matching = { name: "CI result", status: "completed", conclusion: "success", head_sha: HEAD };
      const noSha = { name: "CI result", status: "completed", conclusion: "success" };
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [stale, noSha], headSha: HEAD })).toBe("pending");
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [stale, matching], headSha: HEAD })).toBe("complete");
      expect(pullRequestHeadCiStateFromChecks({ checkRuns: [noSha, matching], headSha: HEAD })).toBe("complete");
    });
  });
});

describe("pullRequestHeadCiStateFromAllChecks", () => {
  const done = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });

  it("is complete when every check of the head has completed, whatever the conclusions", () => {
    // OPE-12048: BastionPrime/wellboard PR #43 — six lanes, no aggregate `CI result` check.
    expect(
      pullRequestHeadCiStateFromAllChecks({
        checkRuns: [
          done("build (x86_64)", "success"),
          done("lint-and-test", "success"),
          done("build (mipsel_24kc)", "failure"),
        ],
      }),
    ).toBe("complete");
  });

  it("is pending while any check is queued, in progress or waiting", () => {
    expect(
      pullRequestHeadCiStateFromAllChecks({
        checkRuns: [done("build", "success"), { name: "lint-and-test", status: "in_progress", conclusion: null }],
      }),
    ).toBe("pending");
    expect(
      pullRequestHeadCiStateFromAllChecks({
        checkRuns: [done("build", "success"), { name: "lint-and-test", status: "queued", conclusion: null }],
      }),
    ).toBe("pending");
    expect(
      pullRequestHeadCiStateFromAllChecks({
        checkRuns: [done("build", "success"), { name: "lint-and-test", status: "waiting", conclusion: null }],
      }),
    ).toBe("pending");
  });

  it("is pending while CI has not started at all", () => {
    expect(pullRequestHeadCiStateFromAllChecks({ checkRuns: [] })).toBe("pending");
  });

  it("is unknown when the read failed", () => {
    expect(pullRequestHeadCiStateFromAllChecks({ checkRuns: null })).toBe("unknown");
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

describe("maintenance-interrupted reviewer run (OPE-12201)", () => {
  it("recognises only a run cancelled by the maintenance drain", () => {
    expect(isMaintenanceInterruptedRun({ status: "cancelled", errorCode: "myrmidon_maintenance_interrupted" })).toBe(true);
    expect(isMaintenanceInterruptedRun({ status: "cancelled", errorCode: "cancelled" })).toBe(false);
    expect(isMaintenanceInterruptedRun({ status: "failed", errorCode: "myrmidon_maintenance_interrupted" })).toBe(false);
    expect(isMaintenanceInterruptedRun({ status: "succeeded", errorCode: null })).toBe(false);
    expect(isMaintenanceInterruptedRun(null)).toBe(false);
  });

  it("does not spend the decision budget: maintenance_retry rows are not counted", () => {
    const rows = [
      { details: { stageId: "s1", kind: "maintenance_retry" } },
      { details: { stageId: "s1", kind: "maintenance_retry" } },
      { details: { stageId: "s1", kind: "decision_retry" } },
    ];
    expect(countStalledReviewDeferrals(rows, "s1")).toEqual({ ciWaits: 0, decisionRetries: 1 });
  });
});

describe("pullRequestHeadFinalCheckConclusion", () => {
  const done = (conclusion: string) => ({ name: "CI result", status: "completed", conclusion });

  it("returns the conclusion of the completed final check", () => {
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [done("success")] })).toBe("success");
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [done("failure")] })).toBe("failure");
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [{ name: "checks", status: "completed", conclusion: "failure" }, done("success")] })).toBe("success");
  });

  it("ignores superseded runs and non-verdict conclusions", () => {
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [done("cancelled"), done("success")] })).toBe("success");
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [{ name: "CI result", status: "queued" }] })).toBeNull();
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [{ name: "CI result", status: "completed" }] })).toBeNull();
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [] })).toBeNull();
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: null })).toBeNull();
  });

  it("filters by headSha when provided", () => {
    const stale = { name: "CI result", status: "completed", conclusion: "failure", head_sha: "deadbeef" };
    const matching = { name: "CI result", status: "completed", conclusion: "success", head_sha: "abc123" };
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [stale], headSha: "abc123" })).toBeNull();
    expect(pullRequestHeadFinalCheckConclusion({ checkRuns: [stale, matching], headSha: "abc123" })).toBe("success");
  });
});

describe("decideReviewAdmission (OPE-12176)", () => {
  it("admits the reviewer when the exact head CI is green", () => {
    expect(decideReviewAdmission({ ci: "complete", headFinalCheck: "green", critical: false })).toBe("admit");
  });

  it("waits for the fix (wait_red) when the exact head CI finished with a failed check", () => {
    expect(decideReviewAdmission({ ci: "complete", headFinalCheck: "red", critical: false })).toBe(
      "wait_red",
    );
  });

  it("waits for CI (wait_for_ci) while the head CI is pending or unreadable", () => {
    expect(decideReviewAdmission({ ci: "pending", headFinalCheck: "unknown", critical: false })).toBe("wait_for_ci");
    expect(decideReviewAdmission({ ci: "unknown", headFinalCheck: "unknown", critical: false })).toBe("wait_for_ci");
  });

  it("waits for CI (wait_for_ci) when CI completed but check runs could not be read (unknown)", () => {
    expect(decideReviewAdmission({ ci: "complete", headFinalCheck: "unknown", critical: false })).toBe("wait_for_ci");
  });

  it("admits a critical issue's reviewer even when the exact head CI is red", () => {
    expect(decideReviewAdmission({ ci: "complete", headFinalCheck: "red", critical: true })).toBe("admit");
  });
});
