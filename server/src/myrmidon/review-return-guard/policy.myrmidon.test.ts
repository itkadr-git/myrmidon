import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_INFRA_CHECK_NAMES,
  REVIEW_INFRA_CHECK_NAMES_ENV,
  REVIEW_RETURN_GUARD_ENABLED_ENV,
  buildReviewReturnSuppressedNote,
  failedChecksAreInfraOnly,
  isCiOnlyReviewComment,
  normalizeHeadSha,
  readReviewInfraCheckNames,
  readReviewReturnGuardEnabled,
  repeatedReturnHead,
  reviewCommentReferencesCode,
  withChangesRequestedHeadSha,
} from "./policy.js";

const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HEAD_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334";

describe("settings", () => {
  it("keeps the guard on unless it is explicitly switched off", () => {
    expect(readReviewReturnGuardEnabled({})).toBe(true);
    expect(readReviewReturnGuardEnabled({ [REVIEW_RETURN_GUARD_ENABLED_ENV]: "1" })).toBe(true);
    expect(readReviewReturnGuardEnabled({ [REVIEW_RETURN_GUARD_ENABLED_ENV]: "typo" })).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      expect(readReviewReturnGuardEnabled({ [REVIEW_RETURN_GUARD_ENABLED_ENV]: off })).toBe(false);
    }
  });

  it("reads the infrastructure check names: defaults, a replacing list, an empty list", () => {
    expect(readReviewInfraCheckNames({})).toEqual([...DEFAULT_REVIEW_INFRA_CHECK_NAMES]);
    expect(DEFAULT_REVIEW_INFRA_CHECK_NAMES).toEqual(["CI result", "main-green"]);
    expect(
      readReviewInfraCheckNames({ [REVIEW_INFRA_CHECK_NAMES_ENV]: "CI result, plugin readiness timing\n main-green " }),
    ).toEqual(["CI result", "plugin readiness timing", "main-green"]);
    expect(readReviewInfraCheckNames({ [REVIEW_INFRA_CHECK_NAMES_ENV]: "" })).toEqual([]);
  });
});

describe("head sha", () => {
  it("accepts a hex commit id and lower-cases it, rejects anything else", () => {
    expect(normalizeHeadSha(HEAD_A.toUpperCase())).toBe(HEAD_A);
    expect(normalizeHeadSha(` ${HEAD_A} `)).toBe(HEAD_A);
    expect(normalizeHeadSha("abc")).toBeNull();
    expect(normalizeHeadSha("head-abc")).toBeNull();
    expect(normalizeHeadSha("")).toBeNull();
    expect(normalizeHeadSha(null)).toBeNull();
    expect(normalizeHeadSha(undefined)).toBeNull();
  });

  it("writes the head into a state and removes it when the head is unknown", () => {
    const state = { status: "changes_requested", lastDecisionId: "d1" };
    expect(withChangesRequestedHeadSha(state, HEAD_A)).toEqual({ ...state, lastChangesRequestedHeadSha: HEAD_A });
    // The input is not mutated.
    expect(state).toEqual({ status: "changes_requested", lastDecisionId: "d1" });
    expect(withChangesRequestedHeadSha({ ...state, lastChangesRequestedHeadSha: HEAD_A }, HEAD_B)).toEqual({
      ...state,
      lastChangesRequestedHeadSha: HEAD_B,
    });
    expect(withChangesRequestedHeadSha({ ...state, lastChangesRequestedHeadSha: HEAD_A }, null)).toEqual(state);
    expect(withChangesRequestedHeadSha({ ...state, lastChangesRequestedHeadSha: HEAD_A }, "head-abc")).toEqual(state);
  });
});

describe("repeatedReturnHead", () => {
  const returned = (head: string | null, status = "changes_requested") => ({
    status,
    ...(head ? { lastChangesRequestedHeadSha: head } : {}),
  });

  it("names the head when the new return is on the head of the previous return", () => {
    expect(repeatedReturnHead(returned(HEAD_A, "pending"), returned(HEAD_A))).toBe(HEAD_A);
    expect(repeatedReturnHead(returned(HEAD_A.toUpperCase(), "pending"), returned(HEAD_A))).toBe(HEAD_A);
  });

  it("is not a repeat after a new commit", () => {
    expect(repeatedReturnHead(returned(HEAD_A, "pending"), returned(HEAD_B))).toBeNull();
  });

  it("is not a repeat when either head is unknown", () => {
    expect(repeatedReturnHead(returned(null, "pending"), returned(HEAD_A))).toBeNull();
    expect(repeatedReturnHead(returned(HEAD_A, "pending"), returned(null))).toBeNull();
    expect(repeatedReturnHead(null, returned(HEAD_A))).toBeNull();
    expect(repeatedReturnHead(undefined, undefined)).toBeNull();
  });

  it("only looks at a return (changes_requested)", () => {
    expect(repeatedReturnHead(returned(HEAD_A, "pending"), returned(HEAD_A, "pending"))).toBeNull();
    expect(repeatedReturnHead(returned(HEAD_A, "pending"), returned(HEAD_A, "completed"))).toBeNull();
  });
});

describe("isCiOnlyReviewComment", () => {
  it("reads a short comment about CI as a CI report", () => {
    expect(
      isCiOnlyReviewComment(
        "REQUEST CHANGES PR #2480 a1b2c3d: exact-head CI is terminal FAILURE: CI result and main-green failed.",
      ),
    ).toBe(true);
    expect(isCiOnlyReviewComment("The checks on this head are red, please look at the workflow run.")).toBe(true);
  });

  it("does not read a comment that cites a file, a line or a code block", () => {
    expect(isCiOnlyReviewComment("CI result failed. server/src/routes/issues.ts drops the guard")).toBe(false);
    expect(isCiOnlyReviewComment("CI is red because of chat-channels.integration.test.ts")).toBe(false);
    expect(isCiOnlyReviewComment("CI is red, see line 120 of the handler")).toBe(false);
    expect(isCiOnlyReviewComment("CI is red, строка 14 не проверяет null")).toBe(false);
    expect(isCiOnlyReviewComment("CI is red:\n```ts\nconst x = 1;\n```")).toBe(false);
  });

  it("does not read a comment that is not about CI at all", () => {
    expect(isCiOnlyReviewComment("The retry loop never gives up on a closed socket")).toBe(false);
  });

  it("does not read an empty or a very long comment", () => {
    expect(isCiOnlyReviewComment("")).toBe(false);
    expect(isCiOnlyReviewComment("   ")).toBe(false);
    expect(isCiOnlyReviewComment(null)).toBe(false);
    expect(isCiOnlyReviewComment(undefined)).toBe(false);
    expect(isCiOnlyReviewComment(`CI is red. ${"The review continues. ".repeat(300)}`)).toBe(false);
  });
});

describe("reviewCommentReferencesCode", () => {
  it("identifies comments referencing code (path:line, file name, code fence)", () => {
    expect(reviewCommentReferencesCode("repack.js:318 without cleanup after failure.")).toBe(true);
    expect(reviewCommentReferencesCode("server/src/routes/issues.ts line 14592")).toBe(true);
    expect(reviewCommentReferencesCode("Check the code:\n```ts\nconst x = 1;\n```")).toBe(true);
    expect(reviewCommentReferencesCode("The CI result must be checked first.")).toBe(false);
    expect(reviewCommentReferencesCode("")).toBe(false);
    expect(reviewCommentReferencesCode(null)).toBe(false);
  });
});

describe("failedChecksAreInfraOnly", () => {
  const infra = ["CI result", "main-green"];

  it("is true when every failed check is on the list, in any letter case", () => {
    expect(failedChecksAreInfraOnly(["CI result"], infra)).toBe(true);
    expect(failedChecksAreInfraOnly(["ci RESULT", " main-green "], infra)).toBe(true);
  });

  it("is false when one failed check is a lane of the code", () => {
    expect(failedChecksAreInfraOnly(["tests (affected)", "CI result"], infra)).toBe(false);
    expect(failedChecksAreInfraOnly(["typecheck + build"], infra)).toBe(false);
  });

  it("is false without failed checks or without a list", () => {
    expect(failedChecksAreInfraOnly([], infra)).toBe(false);
    expect(failedChecksAreInfraOnly(["CI result"], [])).toBe(false);
  });
});

describe("buildReviewReturnSuppressedNote", () => {
  it("names the short head and what is needed for a repeated return", () => {
    const note = buildReviewReturnSuppressedNote({ action: "suppress", reason: "repeat_same_head", headSha: HEAD_A });
    expect(note).toContain(HEAD_A.slice(0, 8));
    expect(note).toContain("Повторный возврат на той же голове PR");
    expect(note).toContain("без нового коммита");
    expect(note).toContain("исполнитель не будится");
    expect(note).toContain("Нужен новый коммит или новые замечания к коду");
  });

  it("names the failed checks and the retry for an infrastructure-only return", () => {
    const note = buildReviewReturnSuppressedNote({
      action: "suppress",
      reason: "ci_infra_only",
      headSha: HEAD_B,
      failedChecks: ["CI result", "main-green"],
      pullRequestUrl: null,
    });
    expect(note).toContain(HEAD_B.slice(0, 8));
    expect(note).toContain("CI result, main-green");
    expect(note).toContain("ci_infra_retry_needed");
    expect(note).toContain("исполнитель не будится");
  });
});
