// myrmidon(OPE-11767): the pure half of the board-side merge — which head a
// verdict covers, and the decision table for one approved pull request.

import { describe, expect, it } from "vitest";
import {
  declaredReviewedHead,
  decideBoardMerge,
  pullRequiresFullCi,
  requiredChecksForPull,
  reviewedHeadMatches,
  verdictCoversHead,
  BOARD_MERGE_FULL_CI_LABEL,
  type BoardMergeFacts,
  type RequiredCheckVerdict,
} from "./pr-policy.js";

const HEAD = "28f15c1be15204153f0e06464842d88875c373f8";
const VERDICT = `APPROVE PR #2467 ${HEAD}\nГолова: ${HEAD}. Авторитетный CI завершён успешно.`;

function facts(overrides: Partial<BoardMergeFacts> = {}): BoardMergeFacts {
  return {
    open: true,
    draft: false,
    headSha: HEAD,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    labels: [],
    ...overrides,
  };
}

function decide(
  overrides: Partial<BoardMergeFacts> = {},
  checks: Record<string, RequiredCheckVerdict> | null = { "CI result": "success" },
  verdict: string | null = VERDICT,
) {
  return decideBoardMerge({
    facts: facts(overrides),
    baseBranches: ["main"],
    verdict,
    checks,
    requiredChecks: ["CI result"],
  });
}

describe("the head a verdict covers", () => {
  it("reads the sha the reviewers actually write: `APPROVE PR #N <sha>` and `Голова: <sha>`", () => {
    expect(declaredReviewedHead(VERDICT)).toBe(HEAD);
    expect(declaredReviewedHead("APPROVE PR #2449 d75e816fcea7d115ababc4dad032687ffc8ed14c\nТочный head подтверждён authoritative board CI")).toBe(
      "d75e816fcea7d115ababc4dad032687ffc8ed14c",
    );
  });

  it("keeps the explicit `head <sha>` spelling first", () => {
    expect(declaredReviewedHead("VERDICT #123: APPROVE (head abc1234)")).toBe("abc1234");
    expect(declaredReviewedHead("ВЕРДИКТ: APPROVE head def567890123456")).toBe("def567890123456");
    expect(declaredReviewedHead("HEAD: 1234567")).toBe("1234567");
    expect(declaredReviewedHead("old 1111111 rejected, now head 2222222")).toBe("2222222");
  });

  it("a verdict without a sha declares none; a hex-only word is not a sha", () => {
    expect(declaredReviewedHead("VERDICT: APPROVE (no head specified)")).toBeNull();
    expect(declaredReviewedHead("VERDICT: APPROVE looks good to me")).toBeNull();
    expect(declaredReviewedHead("a defaced facade, decade")).toBeNull();
    expect(declaredReviewedHead("")).toBeNull();
    expect(declaredReviewedHead(null)).toBeNull();
    expect(declaredReviewedHead("see PR #2467 and issue 1234567890")).toBeNull();
  });

  it("matches the current head by prefix in either direction, never a different or a too short sha", () => {
    expect(reviewedHeadMatches(HEAD, HEAD)).toBe(true);
    expect(reviewedHeadMatches(HEAD.slice(0, 12), HEAD)).toBe(true);
    expect(reviewedHeadMatches(HEAD, HEAD.slice(0, 12))).toBe(true);
    expect(reviewedHeadMatches(HEAD.toUpperCase(), HEAD)).toBe(true);
    expect(reviewedHeadMatches("0123456789ab", HEAD)).toBe(false);
    expect(reviewedHeadMatches(HEAD.slice(0, 6), HEAD)).toBe(false);
    expect(reviewedHeadMatches(null, HEAD)).toBe(false);
    expect(reviewedHeadMatches(HEAD, null)).toBe(false);
  });

  it("an approval covers only the head it names", () => {
    expect(verdictCoversHead(VERDICT, HEAD)).toBe(true);
    expect(verdictCoversHead(VERDICT, "0123456789abcdef0123456789abcdef01234567")).toBe(false);
    expect(verdictCoversHead("APPROVE", HEAD)).toBe(false);
  });
});

describe("the decision for one approved pull request", () => {
  it("merges a head that is green and mergeable as it stands", () => {
    expect(decide()).toEqual({ kind: "merge" });
    expect(decide({ mergeableState: "unstable" })).toEqual({ kind: "merge" });
    expect(decide({ mergeableState: "has_hooks" })).toEqual({ kind: "merge" });
  });

  it("asks for the required checks only once everything else is settled", () => {
    expect(decide({}, null)).toEqual({ kind: "read_checks" });
    // Not worth a check request: the answer does not depend on it.
    expect(decide({ baseRef: "dev" }, null)).toEqual({ kind: "skip", reason: "base_not_allowed" });
    expect(decide({ mergeable: false, mergeableState: "dirty" }, null)).toEqual({ kind: "return", reason: "conflict" });
    expect(decide({ mergeable: null, mergeableState: "unknown" }, null)).toEqual({ kind: "wait", reason: "mergeability_unknown" });
  });

  it("waits for a check that is running or missing, and for one that failed", () => {
    expect(decide({}, { "CI result": "pending" })).toEqual({ kind: "wait", reason: "ci_pending" });
    expect(decide({}, {})).toEqual({ kind: "wait", reason: "ci_pending" });
    expect(decide({}, { "CI result": "failed" })).toEqual({ kind: "wait", reason: "ci_failed" });
    expect(
      decideBoardMerge({
        facts: facts(),
        baseBranches: ["main"],
        verdict: VERDICT,
        checks: { "CI result": "success", "second gate": "pending" },
        requiredChecks: ["CI result", "second gate"],
      }),
    ).toEqual({ kind: "wait", reason: "ci_pending" });
  });

  it("a conflict, or a head behind a base that must be current, goes back to the implementer, before CI", () => {
    expect(decide({ mergeable: false, mergeableState: "dirty" })).toEqual({ kind: "return", reason: "conflict" });
    expect(decide({ mergeable: false, mergeableState: "unknown" })).toEqual({ kind: "return", reason: "conflict" });
    expect(decide({ mergeableState: "behind" })).toEqual({ kind: "return", reason: "behind" });
    expect(decide({ mergeableState: "dirty" }, { "CI result": "pending" })).toEqual({ kind: "return", reason: "conflict" });
  });

  it("never merges what is closed, a draft, headless, on another base, or approved at another head", () => {
    expect(decide({ open: false })).toEqual({ kind: "skip", reason: "closed" });
    expect(decide({ draft: true })).toEqual({ kind: "skip", reason: "draft" });
    expect(decide({ mergeableState: "draft" })).toEqual({ kind: "skip", reason: "draft" });
    expect(decide({ headSha: null })).toEqual({ kind: "skip", reason: "no_head" });
    expect(decide({ baseRef: "rel/1.6.6" })).toEqual({ kind: "skip", reason: "base_not_allowed" });
    expect(decide({ baseRef: null })).toEqual({ kind: "skip", reason: "base_not_allowed" });
    expect(decide({}, { "CI result": "success" }, null)).toEqual({ kind: "skip", reason: "head_not_approved" });
    expect(decide({}, { "CI result": "success" }, "APPROVE, looks good")).toEqual({ kind: "skip", reason: "head_not_approved" });
  });

  it("an approval of another head goes back to the implementer to resubmit (the branch moved after the verdict)", () => {
    expect(decide({ headSha: "0123456789abcdef0123456789abcdef01234567" })).toEqual({ kind: "return", reason: "head_moved" });
    expect(decide({ headSha: "0123456789abcdef0123456789abcdef01234567" }, null)).toEqual({ kind: "return", reason: "head_moved" });
    expect(decide({ headSha: "0123456789abcdef0123456789abcdef01234567", open: false })).toEqual({ kind: "skip", reason: "closed" });
  });

  it("a configured release base is merged into", () => {
    expect(
      decideBoardMerge({
        facts: facts({ baseRef: "rel/1.6.6" }),
        baseBranches: ["main", "rel/1.6.6"],
        verdict: VERDICT,
        checks: { "CI result": "success" },
        requiredChecks: ["CI result"],
      }),
    ).toEqual({ kind: "merge" });
  });

  it("blocked: asks for the review marker when it is missing, otherwise waits", () => {
    expect(decide({ mergeableState: "blocked" })).toEqual({ kind: "label" });
    expect(decide({ mergeableState: "blocked", labels: ["review-approved"] })).toEqual({ kind: "wait", reason: "blocked" });
    // A state the board does not know is not merged.
    expect(decide({ mergeableState: "mystery" })).toEqual({ kind: "wait", reason: "blocked" });
  });

  describe("full-ci requirements (OPE-12551)", () => {
    it("identifies paths requiring full CI", () => {
      expect(pullRequiresFullCi(["server/src/index.ts"])).toBe(true);
      expect(pullRequiresFullCi(["packages/paperclip-runner/src/driver.ts"])).toBe(true);
      expect(pullRequiresFullCi(["docs/readme.md", "packages/shared/src/index.ts"])).toBe(false);
    });

    it("expands required checks when server/src or runner files are touched", () => {
      expect(
        requiredChecksForPull({
          defaultChecks: ["CI result"],
          files: ["docs/readme.md"],
        }),
      ).toEqual(["CI result"]);

      expect(
        requiredChecksForPull({
          defaultChecks: ["CI result"],
          files: ["server/src/routes.ts"],
        }),
      ).toEqual(["CI result", "tests (server 1/6)"]);

      expect(
        requiredChecksForPull({
          defaultChecks: ["CI result"],
          files: ["packages/paperclip-runner/src/index.ts"],
        }),
      ).toEqual(["CI result", "tests (other + runner)"]);

      expect(
        requiredChecksForPull({
          defaultChecks: ["CI result"],
          files: ["server/src/index.ts", "packages/paperclip-runner/src/index.ts"],
        }),
      ).toEqual(["CI result", "tests (server 1/6)", "tests (other + runner)"]);

      expect(
        requiredChecksForPull({
          defaultChecks: ["CI result"],
          labels: [BOARD_MERGE_FULL_CI_LABEL],
        }),
      ).toEqual(["CI result", "tests (server 1/6)", "tests (other + runner)"]);
    });

    it("demands full-ci label when server/src or runner files are touched without label", () => {
      expect(
        decideBoardMerge({
          facts: facts(),
          baseBranches: ["main"],
          verdict: VERDICT,
          checks: { "CI result": "success" },
          requiredChecks: ["CI result"],
          files: ["server/src/index.ts"],
        }),
      ).toEqual({ kind: "label", label: BOARD_MERGE_FULL_CI_LABEL });
    });

    it("waits for full-ci checks when full-ci label is set but checks are pending", () => {
      expect(
        decideBoardMerge({
          facts: facts({ labels: [BOARD_MERGE_FULL_CI_LABEL] }),
          baseBranches: ["main"],
          verdict: VERDICT,
          checks: { "CI result": "success", "tests (server 1/6)": "pending" },
          requiredChecks: ["CI result", "tests (server 1/6)"],
          files: ["server/src/index.ts"],
        }),
      ).toEqual({ kind: "wait", reason: "ci_pending" });
    });

    it("merges when full-ci label is set and all full checks succeeded", () => {
      expect(
        decideBoardMerge({
          facts: facts({ labels: [BOARD_MERGE_FULL_CI_LABEL] }),
          baseBranches: ["main"],
          verdict: VERDICT,
          checks: { "CI result": "success", "tests (server 1/6)": "success" },
          requiredChecks: ["CI result", "tests (server 1/6)"],
          files: ["server/src/index.ts"],
        }),
      ).toEqual({ kind: "merge" });
    });
  });
});
