import { describe, expect, it } from "vitest";
import {
  REVIEW_VERDICT_STATE_KEY,
  extractReviewVerdictRecord,
  readReviewVerdictRecord,
  withReviewVerdictRecord,
} from "./record.js";
import { isApprovalOutcome, parseReviewedHead } from "../../services/pull-request-approval-propagation.js";

const HEAD = "28f15c1be15204153f0e06464842d88875c373f8";

describe("review-verdict record (OPE-12181)", () => {
  describe("extractReviewVerdictRecord", () => {
    it("records an APPROVE verdict with head sha and PR number", () => {
      const record = extractReviewVerdictRecord({
        outcome: "approved",
        body: `APPROVE PR #2467 ${HEAD}\nГолова подтверждена, CI зелёный.`,
      });
      expect(record).toEqual({
        reviewDecision: "approved",
        headSha: HEAD,
        pullRequestNumber: 2467,
      });
    });

    it("records a REQUEST CHANGES verdict", () => {
      const record = extractReviewVerdictRecord({
        outcome: "changes_requested",
        body: "REQUEST CHANGES PR #2449 — flaky ci-pr-tests, re-run after push",
      });
      expect(record).toEqual({
        reviewDecision: "changes_requested",
        headSha: null,
        pullRequestNumber: 2449,
      });
    });

    it("keeps an explicitly provided head sha over the parsed one", () => {
      const record = extractReviewVerdictRecord({
        outcome: "approved",
        body: `APPROVE PR #2467 ${HEAD}`,
        headSha: "d75e816fcea7d115ababc4dad032687ffc8ed14c",
      });
      expect(record?.headSha).toBe("d75e816fcea7d115ababc4dad032687ffc8ed14c");
    });

    it("returns null for a non-verdict outcome", () => {
      expect(
        extractReviewVerdictRecord({ outcome: "deferred", body: "APPROVE PR #1" }),
      ).toBeNull();
      expect(extractReviewVerdictRecord({ outcome: null, body: "APPROVE PR #1" })).toBeNull();
    });
  });

  describe("readReviewVerdictRecord", () => {
    it("reads the record stored in an execution state", () => {
      const state = {
        status: "completed",
        lastDecisionId: "6d1e2c1a-0000-4000-8000-000000000001",
        lastDecisionOutcome: "approved",
        [REVIEW_VERDICT_STATE_KEY]: {
          reviewDecision: "approved",
          headSha: HEAD,
          pullRequestNumber: 2467,
        },
      };
      expect(readReviewVerdictRecord(state)).toEqual({
        reviewDecision: "approved",
        headSha: HEAD,
        pullRequestNumber: 2467,
      });
    });

    it("returns null for old states without the structure (fallback stays)", () => {
      expect(
        readReviewVerdictRecord({
          status: "completed",
          lastDecisionId: "6d1e2c1a-0000-4000-8000-000000000001",
          lastDecisionOutcome: "approved",
        }),
      ).toBeNull();
      expect(readReviewVerdictRecord(null)).toBeNull();
      expect(readReviewVerdictRecord(undefined)).toBeNull();
    });

    it("rejects a malformed record", () => {
      expect(
        readReviewVerdictRecord({ [REVIEW_VERDICT_STATE_KEY]: { reviewDecision: "maybe" } }),
      ).toBeNull();
    });
  });

  describe("withReviewVerdictRecord", () => {
    it("writes and clears the record without mutating the input", () => {
      const state = { status: "completed", lastDecisionId: "x" };
      const record = extractReviewVerdictRecord({
        outcome: "approved",
        body: `APPROVE PR #2467 ${HEAD}`,
      });
      const next = withReviewVerdictRecord(state, record);
      expect(next[REVIEW_VERDICT_STATE_KEY]).toEqual(record);
      expect(REVIEW_VERDICT_STATE_KEY in state).toBe(false);

      const cleared = withReviewVerdictRecord(next, null);
      expect(REVIEW_VERDICT_STATE_KEY in cleared).toBe(false);
    });
  });

  describe("consumer prefers structure over re-parsing (OPE-12181)", () => {
    it("isApprovalOutcome reads the record and skips the regexes", () => {
      // A record saying changes_requested wins even when the comment text
      // mentions APPROVE — no text re-parse once structure exists.
      expect(
        isApprovalOutcome("changes_requested", "APPROVE looks fine", {
          reviewDecision: "changes_requested",
          headSha: HEAD,
          pullRequestNumber: 2467,
        }),
      ).toBe(false);
      // An approved record wins even when the text carries a negative word.
      expect(
        isApprovalOutcome(null, "REQUEST CHANGES was the old verdict", {
          reviewDecision: "approved",
          headSha: HEAD,
          pullRequestNumber: 2467,
        }),
      ).toBe(true);
    });

    it("falls back to text parsing when no record exists (old tickets)", () => {
      expect(isApprovalOutcome(null, "APPROVE PR #2467")).toBe(true);
      expect(isApprovalOutcome(null, "REQUEST CHANGES PR #2467")).toBe(false);
      expect(parseReviewedHead(`APPROVE PR #2467 ${HEAD}`)).toBe(HEAD);
    });
  });
});
