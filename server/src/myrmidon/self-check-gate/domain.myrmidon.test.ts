import { describe, expect, it } from "vitest";
import {
  MYRMIDON_SELF_CHECK_REJECT_CODES,
  isMyrmidonDiffEmpty,
  isCheckResultStale,
  evaluateSelfCheckGate,
  assertSelfCheckGate,
  SelfCheckGateError,
  type MyrmidonDiffStats,
  type MyrmidonRunCheckResult,
} from "./domain.js";

describe("domain unit-tests (pre-in_review stop-gate)", () => {
  const currentHeadSha = "42c79c5da4327601f290f72623c4fa0dbb3e4eb8";
  const validDiff: MyrmidonDiffStats = {
    changedFiles: 2,
    additions: 45,
    deletions: 12,
  };

  const greenTest: MyrmidonRunCheckResult = {
    status: "success",
    headSha: currentHeadSha,
    finishedAt: new Date(),
  };

  const greenLint: MyrmidonRunCheckResult = {
    status: "success",
    headSha: currentHeadSha,
    finishedAt: new Date(),
  };

  // 1. пустой дифф → reject
  it("пустой дифф → reject (EMPTY_DIFF)", () => {
    // null diff
    const resNull = evaluateSelfCheckGate({
      currentHeadSha,
      diff: null,
      test: greenTest,
      lint: greenLint,
    });
    expect(resNull.admitted).toBe(false);
    expect(resNull.kind).toBe("reject");
    if (resNull.kind === "reject") {
      expect(resNull.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    }

    // 0 files, 0 additions, 0 deletions
    const resEmpty = evaluateSelfCheckGate({
      currentHeadSha,
      diff: { changedFiles: 0, additions: 0, deletions: 0 },
      test: greenTest,
      lint: greenLint,
    });
    expect(resEmpty.admitted).toBe(false);
    if (resEmpty.kind === "reject") {
      expect(resEmpty.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    }

    // 1 file, 0 additions, 0 deletions
    const resNoLines = evaluateSelfCheckGate({
      currentHeadSha,
      diff: { changedFiles: 1, additions: 0, deletions: 0 },
      test: greenTest,
      lint: greenLint,
    });
    expect(resNoLines.admitted).toBe(false);
    if (resNoLines.kind === "reject") {
      expect(resNoLines.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.EMPTY_DIFF);
    }
  });

  // 2. упавший линт → reject
  it("упавший линт → reject (LINT_FAILED)", () => {
    const res = evaluateSelfCheckGate({
      currentHeadSha,
      diff: validDiff,
      test: greenTest,
      lint: {
        status: "failure",
        headSha: currentHeadSha,
        finishedAt: new Date(),
      },
    });
    expect(res.admitted).toBe(false);
    expect(res.kind).toBe("reject");
    if (res.kind === "reject") {
      expect(res.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.LINT_FAILED);
    }
  });

  // 3. чужой (устаревший) head результата → reject
  it("чужой (устаревший) head результата → reject (STALE_TEST / STALE_LINT)", () => {
    const staleTestRes = evaluateSelfCheckGate({
      currentHeadSha,
      diff: validDiff,
      test: {
        status: "success",
        headSha: "0000000000000000000000000000000000000000",
        finishedAt: new Date(),
      },
      lint: greenLint,
    });
    expect(staleTestRes.admitted).toBe(false);
    if (staleTestRes.kind === "reject") {
      expect(staleTestRes.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_TEST);
    }

    const staleLintRes = evaluateSelfCheckGate({
      currentHeadSha,
      diff: validDiff,
      test: greenTest,
      lint: {
        status: "success",
        headSha: "ffffffffffffffffffffffffffffffffffffffff",
        finishedAt: new Date(),
      },
    });
    expect(staleLintRes.admitted).toBe(false);
    if (staleLintRes.kind === "reject") {
      expect(staleLintRes.code).toBe(MYRMIDON_SELF_CHECK_REJECT_CODES.STALE_LINT);
    }
  });

  // 4. зелёный свежий + непустой дифф → admit
  it("зелёный свежий + непустой дифф → admit", () => {
    const res = evaluateSelfCheckGate({
      currentHeadSha,
      diff: validDiff,
      test: greenTest,
      lint: greenLint,
    });
    expect(res.admitted).toBe(true);
    expect(res.kind).toBe("admit");
  });

  // 5. reject содержит код причины и текст продолжения
  it("reject содержит код причины и текст продолжения", () => {
    const res = evaluateSelfCheckGate({
      currentHeadSha,
      diff: null,
      test: greenTest,
      lint: greenLint,
    });
    expect(res.admitted).toBe(false);
    if (res.kind === "reject") {
      expect(res.code).toBe("EMPTY_DIFF");
      expect(res.message).toBeTruthy();
      expect(res.message).toContain("EMPTY_DIFF");
      expect(res.message).toContain("in_review");
      expect(res.reason).toBe(res.message);
    }
  });
});
