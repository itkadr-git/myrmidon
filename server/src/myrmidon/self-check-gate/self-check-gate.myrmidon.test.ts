import { describe, expect, it } from "vitest";
import {
  MYRMIDON_SELF_CHECK_REJECT_CODES,
  isMyrmidonDiffEmpty,
  isSameCommitSha,
  isCheckResultStale,
  evaluateSelfCheckGate,
  assertSelfCheckGate,
  SelfCheckGateError,
  type MyrmidonDiffStats,
  type MyrmidonRunCheckResult,
} from "./index.js";

describe("myrmidon(SELF-CHECK-GATE) stop-gate domain", () => {
  const currentHeadSha = "42c79c5da4327601f290f72623c4fa0dbb3e4eb8";
  const validDiff: MyrmidonDiffStats = {
    changedFiles: 3,
    additions: 120,
    deletions: 15,
  };

  const freshSuccessTest: MyrmidonRunCheckResult = {
    status: "success",
    headSha: currentHeadSha,
    finishedAt: new Date(),
  };

  const freshSuccessLint: MyrmidonRunCheckResult = {
    status: "success",
    headSha: currentHeadSha,
    finishedAt: new Date(),
  };

  describe("empty diff rejection (always reject)", () => {
    it("rejects when diff is null or undefined", () => {
      const decisionNull = evaluateSelfCheckGate({
        currentHeadSha,
        diff: null,
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decisionNull.admitted).toBe(false);
      expect(decisionNull.kind).toBe("reject");
      if (decisionNull.kind === "reject") {
        expect(decisionNull.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
        expect(decisionNull.message).toContain("EMPTY_DIFF");
        expect(decisionNull.message).toContain("Пустой дифф");
      }

      const decisionUndef = evaluateSelfCheckGate({
        currentHeadSha,
        diff: undefined,
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decisionUndef.admitted).toBe(false);
      if (decisionUndef.kind === "reject") {
        expect(decisionUndef.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
      }
    });

    it("rejects when changedFiles is 0", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: { changedFiles: 0, additions: 0, deletions: 0 },
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
      }
    });

    it("rejects when changedFiles is 0 even if additions/deletions non-zero", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: { changedFiles: 0, additions: 10, deletions: 5 },
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
      }
    });

    it("rejects when additions and deletions are both 0 (0+0 lines)", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: { changedFiles: 1, additions: 0, deletions: 0 },
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
      }
    });

    it("correctly identifies empty diffs via isMyrmidonDiffEmpty", () => {
      expect(isMyrmidonDiffEmpty(null)).toBe(true);
      expect(isMyrmidonDiffEmpty(undefined)).toBe(true);
      expect(isMyrmidonDiffEmpty({ changedFiles: 0, additions: 0, deletions: 0 })).toBe(true);
      expect(isMyrmidonDiffEmpty({ changedFiles: 1, additions: 0, deletions: 0 })).toBe(true);
      expect(isMyrmidonDiffEmpty({ changedFiles: 0, additions: 5, deletions: 0 })).toBe(true);
      expect(isMyrmidonDiffEmpty({ changedFiles: 1, additions: 1, deletions: 0 })).toBe(false);
      expect(isMyrmidonDiffEmpty({ changedFiles: 1, additions: 0, deletions: 1 })).toBe(false);
    });
  });

  describe("failing check rejection", () => {
    it("rejects when lint fails (LINT_FAILED)", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: freshSuccessTest,
        lint: {
          status: "failure",
          headSha: currentHeadSha,
          finishedAt: new Date(),
        },
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.LINT_FAILED);
        expect(decision.message).toContain("LINT_FAILED");
        expect(decision.message.length).toBeGreaterThan(0);
      }
    });

    it("rejects when test fails (TEST_FAILED)", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: {
          status: "failure",
          headSha: currentHeadSha,
          finishedAt: new Date(),
        },
        lint: freshSuccessLint,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.TEST_FAILED);
        expect(decision.message).toContain("TEST_FAILED");
        expect(decision.message.length).toBeGreaterThan(0);
      }
    });

    it("rejects when test or lint result is missing", () => {
      const noTest = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: null,
        lint: freshSuccessLint,
      });
      expect(noTest.admitted).toBe(false);
      if (noTest.kind === "reject") {
        expect(noTest.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.TEST_FAILED);
      }

      const noLint = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: freshSuccessTest,
        lint: null,
      });
      expect(noLint.admitted).toBe(false);
      if (noLint.kind === "reject") {
        expect(noLint.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.LINT_FAILED);
      }
    });

    it("supports distinguishMissing option", () => {
      const noTest = evaluateSelfCheckGate(
        {
          currentHeadSha,
          diff: validDiff,
          test: null,
          lint: freshSuccessLint,
        },
        { distinguishMissing: true },
      );
      expect(noTest.admitted).toBe(false);
      if (noTest.kind === "reject") {
        expect(noTest.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.TEST_MISSING);
      }
    });
  });

  describe("stale check rejection", () => {
    it("rejects when test headSha does not match current run head (STALE_TEST)", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: {
          status: "success",
          headSha: "1111111111111111111111111111111111111111",
          finishedAt: new Date(),
        },
        lint: freshSuccessLint,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_TEST);
        expect(decision.message).toContain("STALE_TEST");
        expect(decision.message).toContain("1111111111111111111111111111111111111111");
      }
    });

    it("rejects when lint headSha does not match current run head (STALE_LINT)", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: freshSuccessTest,
        lint: {
          status: "success",
          headSha: "2222222222222222222222222222222222222222",
          finishedAt: new Date(),
        },
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_LINT);
        expect(decision.message).toContain("STALE_LINT");
        expect(decision.message).toContain("2222222222222222222222222222222222222222");
      }
    });

    it("rejects when check result finished before minFinishedAt cutoff", () => {
      const cutoff = new Date("2026-11-07T14:00:00Z");
      const older = new Date("2026-11-07T13:59:00Z");

      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: {
          status: "success",
          headSha: currentHeadSha,
          finishedAt: older,
        },
        lint: freshSuccessLint,
        minFinishedAt: cutoff,
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_TEST);
      }
    });

    it("rejects when check result age exceeds maxAgeMs", () => {
      const now = Date.now();
      const tenMinutesAgo = new Date(now - 10 * 60 * 1000);

      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: {
          status: "success",
          headSha: currentHeadSha,
          finishedAt: tenMinutesAgo,
        },
        lint: freshSuccessLint,
        evaluatedAt: new Date(now),
        maxAgeMs: 5 * 60 * 1000, // 5 min TTL
      });
      expect(decision.admitted).toBe(false);
      if (decision.kind === "reject") {
        expect(decision.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_TEST);
      }
    });

    it("matches commit SHAs case-insensitively and allows short prefix matches", () => {
      expect(isSameCommitSha("42c79c5", "42C79C5DA4327601F290F72623C4FA0DBB3E4EB8")).toBe(true);
      expect(isSameCommitSha("abc", "abcdef")).toBe(false); // under 7 chars
      expect(isSameCommitSha("1234567", "1234567890")).toBe(true);
      expect(isSameCommitSha("1234567", "7654321")).toBe(false);
    });
  });

  describe("admission (green, fresh checks + non-empty diff)", () => {
    it("admits when diff is non-empty, test is green & fresh, lint is green & fresh", () => {
      const decision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });

      expect(decision.admitted).toBe(true);
      expect(decision.kind).toBe("admit");
    });

    it("admits with additions only or deletions only", () => {
      const decisionAddOnly = evaluateSelfCheckGate({
        currentHeadSha,
        diff: { changedFiles: 1, additions: 5, deletions: 0 },
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decisionAddOnly.admitted).toBe(true);

      const decisionDelOnly = evaluateSelfCheckGate({
        currentHeadSha,
        diff: { changedFiles: 1, additions: 0, deletions: 5 },
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(decisionDelOnly.admitted).toBe(true);
    });
  });

  describe("rejection response structure and assert helper", () => {
    it("reject contains machine code, non-empty text, and actionable continuation instructions", () => {
      const codes = [
        MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF,
        MYRMIDON_SELF_CHECK_REJECT_CODES.TEST_FAILED,
        MYRMIDON_SELF_CHECK_REJECT_CODES.LINT_FAILED,
        MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_TEST,
        MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_LINT,
      ];

      for (const code of codes) {
        expect(code).toBeTruthy();
        expect(typeof code).toBe("string");
      }

      const emptyDiffDecision = evaluateSelfCheckGate({
        currentHeadSha,
        diff: null,
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(emptyDiffDecision.admitted).toBe(false);
      if (emptyDiffDecision.kind === "reject") {
        expect(emptyDiffDecision.code).toBe("EMPTY_DIFF");
        expect(emptyDiffDecision.message).toBeTruthy();
        expect(emptyDiffDecision.message).toContain("EMPTY_DIFF");
        expect(emptyDiffDecision.reason).toBe(emptyDiffDecision.message);
      }
    });

    it("assertSelfCheckGate throws SelfCheckGateError on rejection", () => {
      expect(() =>
        assertSelfCheckGate({
          currentHeadSha,
          diff: null,
          test: freshSuccessTest,
          lint: freshSuccessLint,
        }),
      ).toThrow(SelfCheckGateError);

      try {
        assertSelfCheckGate({
          currentHeadSha,
          diff: null,
          test: freshSuccessTest,
          lint: freshSuccessLint,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(SelfCheckGateError);
        const gateErr = err as SelfCheckGateError;
        expect(gateErr.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
        expect(gateErr.decision.admitted).toBe(false);
      }
    });

    it("assertSelfCheckGate returns admit decision when admitted", () => {
      const admit = assertSelfCheckGate({
        currentHeadSha,
        diff: validDiff,
        test: freshSuccessTest,
        lint: freshSuccessLint,
      });
      expect(admit.admitted).toBe(true);
      expect(admit.kind).toBe("admit");
    });
  });
});
