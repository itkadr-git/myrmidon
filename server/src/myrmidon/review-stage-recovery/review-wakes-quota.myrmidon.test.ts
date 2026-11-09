import { beforeEach, describe, expect, it } from "vitest";
import {
  REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK,
  admitReviewerUnderWakesQuota,
  clearReviewWakesQuotas,
  freshReviewWakesQuota,
  reviewWakesQuotaForCompany,
  reviewWakesQuotaTickStarted,
} from "./review-wakes-quota.js";

// myrmidon(OPE-12178): the per-tick quota of new reviewer wakes.

describe("admitReviewerUnderWakesQuota", () => {
  beforeEach(() => {
    clearReviewWakesQuotas(new Date("2026-11-08T00:00:00.000Z"));
  });

  it("quota 0 admits nothing", () => {
    const quota = { remaining: 0 };
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("quota_reached");
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("quota_reached");
    expect(quota.remaining).toBe(0);
  });

  it("two issues with quota 1: the first wakes, the second defers", () => {
    const quota = freshReviewWakesQuota();
    expect(REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK).toBe(1);
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("admit");
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("quota_reached");
    expect(quota.remaining).toBe(0);
  });

  it("the same admission key is admitted once and re-checked free", () => {
    const quota = freshReviewWakesQuota();
    const key = "issue-review-admission:issue-1:reviewer-1";
    expect(admitReviewerUnderWakesQuota(quota, false, key)).toBe("admit");
    // The post-update wake site re-checks the SAME handoff: free, no second spend.
    expect(admitReviewerUnderWakesQuota(quota, false, key)).toBe("admit");
    expect(quota.remaining).toBe(0);
    // A different admission (second handoff) still defers on the spent budget.
    expect(admitReviewerUnderWakesQuota(quota, false, "issue-review-admission:issue-2:reviewer-2")).toBe(
      "quota_reached",
    );
  });

  it("a critical issue goes outside the quota and never spends it", () => {
    const quota = freshReviewWakesQuota();
    expect(admitReviewerUnderWakesQuota(quota, true)).toBe("admit");
    expect(quota.remaining).toBe(1);
  });

  it("critical admissions do not shrink the budget for non-critical wakes", () => {
    const quota = { remaining: 1 };
    expect(admitReviewerUnderWakesQuota(quota, true)).toBe("admit");
    expect(admitReviewerUnderWakesQuota(quota, true)).toBe("admit");
    expect(quota.remaining).toBe(1);
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("admit");
    expect(quota.remaining).toBe(0);
  });

  it("a missing bucket behaves as an exhausted quota (no accidental admission)", () => {
    expect(admitReviewerUnderWakesQuota(null, false)).toBe("quota_reached");
    expect(admitReviewerUnderWakesQuota(undefined, false)).toBe("quota_reached");
    // Negative drift is clamped, never charged below zero.
    expect(admitReviewerUnderWakesQuota({ remaining: -3 }, false)).toBe("quota_reached");
  });

  it("a negative remaining budget admits nothing and stays clamped", () => {
    const quota = { remaining: -1 };
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("quota_reached");
    expect(quota.remaining).toBe(-1);
  });
});

describe("reviewWakesQuotaForCompany / clearReviewWakesQuotas", () => {
  it("gives each company an independent fresh budget", () => {
    clearReviewWakesQuotas(new Date("2026-11-08T10:00:00.000Z"));
    const alpha = reviewWakesQuotaForCompany("company-alpha");
    const beta = reviewWakesQuotaForCompany("company-beta");
    expect(admitReviewerUnderWakesQuota(alpha, false)).toBe("admit");
    expect(admitReviewerUnderWakesQuota(alpha, false)).toBe("quota_reached");
    // The other company still has its full budget.
    expect(admitReviewerUnderWakesQuota(beta, false)).toBe("admit");
    expect(reviewWakesQuotaTickStarted()).toEqual(new Date("2026-11-08T10:00:00.000Z"));
  });

  it("a new tick restores the budget that the previous tick spent", () => {
    clearReviewWakesQuotas(new Date("2026-11-08T10:00:00.000Z"));
    const quota = reviewWakesQuotaForCompany("company-alpha");
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("admit");
    expect(admitReviewerUnderWakesQuota(quota, false)).toBe("quota_reached");
    clearReviewWakesQuotas(new Date("2026-11-08T10:01:00.000Z"));
    const refreshed = reviewWakesQuotaForCompany("company-alpha");
    expect(admitReviewerUnderWakesQuota(refreshed, false)).toBe("admit");
    expect(reviewWakesQuotaTickStarted()).toEqual(new Date("2026-11-08T10:01:00.000Z"));
  });
});
