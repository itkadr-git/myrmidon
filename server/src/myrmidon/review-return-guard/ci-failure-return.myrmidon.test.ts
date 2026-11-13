import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_INFRA_CHECK_NAMES } from "./policy.js";
import {
  BASE_BRANCH_RED_CHECK_NAME,
  CI_FINAL_ONLY_ENABLED_ENV,
  CI_RETURN_HOLD_METADATA_KEY,
  buildCiReturnHoldNote,
  buildCiReturnNote,
  ciVerdictOfHead,
  classifyCiDelivery,
  decideCiFailureReturn,
  isCiVerdictConclusion,
  isFailedCiConclusion,
  isHeadCiFinal,
  readCiFinalOnlyEnabled,
  readCiReturnHoldMark,
  type CiReturnHeadFacts,
} from "./ci-failure-return.js";

// myrmidon(EMPTY-RUNS-3): which CI delivery carries the result of a pull request
// head, and when a failed result returns the task from review. Pure: the check
// runs of the head are handed in.

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const INFRA = [...DEFAULT_REVIEW_INFRA_CHECK_NAMES];

/** A head whose aggregate `CI result` finished with `conclusion` and whose failed checks are `failed`. */
function finalHead(conclusion: string, failed: string[]): CiReturnHeadFacts {
  return { failed, finished: true, hasFinalCheck: true, finalCheckConclusion: conclusion };
}

describe("isFailedCiConclusion", () => {
  it("counts the failing conclusions and nothing else", () => {
    for (const failed of ["failure", "timed_out", "action_required", "startup_failure"]) {
      expect(isFailedCiConclusion(failed)).toBe(true);
    }
    for (const other of ["success", "cancelled", "skipped", "neutral", "stale", "", null, undefined]) {
      expect(isFailedCiConclusion(other)).toBe(false);
    }
  });
});

describe("settings", () => {
  it("keeps the handling by the final result on unless it is explicitly switched off", () => {
    expect(CI_FINAL_ONLY_ENABLED_ENV).toBe("MYRMIDON_GITHUB_CI_FINAL_ONLY_ENABLED");
    expect(readCiFinalOnlyEnabled({})).toBe(true);
    expect(readCiFinalOnlyEnabled({ [CI_FINAL_ONLY_ENABLED_ENV]: "1" })).toBe(true);
    expect(readCiFinalOnlyEnabled({ [CI_FINAL_ONLY_ENABLED_ENV]: "typo" })).toBe(true);
    for (const off of ["0", "false", "off", "no", " OFF "]) {
      expect(readCiFinalOnlyEnabled({ [CI_FINAL_ONLY_ENABLED_ENV]: off })).toBe(false);
    }
  });
});

describe("classifyCiDelivery", () => {
  it("takes only the aggregate check for the final check; any other check is a lane", () => {
    expect(classifyCiDelivery({ eventName: "check_run", checkName: "CI result" })).toBe("final_check");
    expect(classifyCiDelivery({ eventName: "check_run", checkName: " CI result " })).toBe("final_check");
    expect(classifyCiDelivery({ eventName: "check_run", checkName: "tests (server 3/6)" })).toBe("lane");
    expect(classifyCiDelivery({ eventName: "check_run", checkName: "main-green" })).toBe("lane");
    // The noop aggregate of a label-only run is not the aggregate of the head.
    expect(classifyCiDelivery({ eventName: "check_run", checkName: "CI result (label noop)" })).toBe("lane");
    // A check delivered without its name is one job: it never finishes the CI.
    expect(classifyCiDelivery({ eventName: "check_run", checkName: null })).toBe("lane");
    expect(classifyCiDelivery({ eventName: "check_run", checkName: undefined })).toBe("lane");
    expect(classifyCiDelivery({ eventName: "check_run", checkName: "build", finalCheckName: "build" })).toBe("final_check");
  });

  it("takes a workflow run and a check suite for a whole run, whatever name they carry", () => {
    expect(classifyCiDelivery({ eventName: "workflow_run", checkName: null })).toBe("whole_run");
    expect(classifyCiDelivery({ eventName: "check_suite", checkName: null })).toBe("whole_run");
    expect(classifyCiDelivery({ eventName: "workflow_run", checkName: "CI result" })).toBe("whole_run");
  });
});

describe("isCiVerdictConclusion", () => {
  it("counts a finished run as the result unless it was superseded or skipped", () => {
    for (const verdict of ["success", "failure", "timed_out", "action_required", "startup_failure", "neutral"]) {
      expect(isCiVerdictConclusion(verdict)).toBe(true);
    }
    for (const other of ["cancelled", "skipped", "stale", "", " ", null, undefined]) {
      expect(isCiVerdictConclusion(other)).toBe(false);
    }
  });
});

describe("ciVerdictOfHead", () => {
  it("is the conclusion of the finished aggregate check", () => {
    expect(ciVerdictOfHead(finalHead("failure", ["tests (affected)", "CI result"]))).toBe("failure");
    expect(ciVerdictOfHead(finalHead("success", ["main-green"]))).toBe("success");
    expect(
      ciVerdictOfHead({ failed: ["tests (affected)"], finished: true, hasFinalCheck: true, finalCheckConclusion: null }),
    ).toBeNull();
  });

  it("without the aggregate check, is red when any check failed once every check has finished", () => {
    expect(ciVerdictOfHead({ failed: ["build"], finished: true, hasFinalCheck: false, finalCheckConclusion: null })).toBe("failure");
    expect(ciVerdictOfHead({ failed: [], finished: true, hasFinalCheck: false, finalCheckConclusion: null })).toBe("success");
    expect(ciVerdictOfHead({ failed: ["build"], finished: false, hasFinalCheck: false, finalCheckConclusion: null })).toBeNull();
  });
});

describe("isHeadCiFinal", () => {
  it("with the aggregate check on the head, only its finished run is a verdict", () => {
    expect(isHeadCiFinal(finalHead("failure", ["CI result"]))).toBe(true);
    expect(isHeadCiFinal(finalHead("success", []))).toBe(true);
    // The aggregate is queued, running, cancelled or skipped: no verdict, whatever else finished.
    expect(
      isHeadCiFinal({ failed: ["tests (server 3/6)"], finished: true, hasFinalCheck: true, finalCheckConclusion: null }),
    ).toBe(false);
  });

  it("without the aggregate check, the moment every check has finished", () => {
    expect(isHeadCiFinal({ failed: ["build"], finished: true, hasFinalCheck: false, finalCheckConclusion: null })).toBe(true);
    expect(isHeadCiFinal({ failed: ["build"], finished: false, hasFinalCheck: false, finalCheckConclusion: null })).toBe(false);
  });
});

describe("decideCiFailureReturn", () => {
  const decide = (head: CiReturnHeadFacts, infraCheckNames: readonly string[] = INFRA) =>
    decideCiFailureReturn({ head, infraCheckNames });

  it("waits while the CI of the head has no verdict: one failed lane is not the result", () => {
    expect(
      decide({ failed: ["tests (server 3/6)"], finished: false, hasFinalCheck: false, finalCheckConclusion: null }),
    ).toEqual({ action: "wait" });
    // The aggregate exists but has not finished (or its run was cancelled by a newer one).
    expect(
      decide({ failed: ["tests (server 3/6)"], finished: true, hasFinalCheck: true, finalCheckConclusion: null }),
    ).toEqual({ action: "wait" });
  });

  it("returns a real failure of the head on the final result", () => {
    expect(decide(finalHead("failure", ["typecheck + build", "CI result"]))).toEqual({
      action: "return",
      failedChecks: ["typecheck + build", "CI result"],
    });
  });

  it("holds the task while main-green shows a red base branch", () => {
    expect(decide(finalHead("failure", ["tests (serialized 1/2)", "CI result", "main-green"]))).toEqual({
      action: "hold",
      reason: "base_branch_red",
      failedChecks: ["tests (serialized 1/2)", "CI result", "main-green"],
    });
    // The names are compared whole and case-insensitively, like the infrastructure list.
    expect(decide(finalHead("failure", ["tests (affected)", "CI result", " Main-Green "]))).toMatchObject({
      action: "hold",
      reason: "base_branch_red",
    });
  });

  it("returns the still red head once main-green passes again", () => {
    // The same head after the gate was re-run green: the lanes are still red.
    expect(decide(finalHead("failure", ["tests (serialized 1/2)", "CI result"]))).toEqual({
      action: "return",
      failedChecks: ["tests (serialized 1/2)", "CI result"],
    });
  });

  it("holds a head on which only the aggregate failed: its own gate, a re-run is needed", () => {
    expect(decide(finalHead("failure", ["CI result"]))).toEqual({
      action: "hold",
      reason: "ci_infra_only",
      failedChecks: ["CI result"],
    });
    expect(decide(finalHead("failure", ["CI result", "main-green"]))).toEqual({
      action: "hold",
      reason: "ci_infra_only",
      failedChecks: ["CI result", "main-green"],
    });
  });

  it("has nothing to return when the final result is green", () => {
    expect(decide(finalHead("success", []))).toEqual({ action: "none" });
    // A red main-green beside a green aggregate is the merge gate of a red base, not a CI failure.
    expect(decide(finalHead("success", ["main-green"]))).toEqual({ action: "none" });
  });

  it("decides a repository without the aggregate check from all of its checks", () => {
    const thirdParty = (failed: string[], finished: boolean): CiReturnHeadFacts => ({
      failed,
      finished,
      hasFinalCheck: false,
      finalCheckConclusion: null,
    });
    expect(decide(thirdParty(["build"], false))).toEqual({ action: "wait" });
    expect(decide(thirdParty(["build"], true))).toEqual({ action: "return", failedChecks: ["build"] });
    expect(decide(thirdParty([], true))).toEqual({ action: "none" });
  });

  it("follows the configured infrastructure list: without main-green on it there is no base-branch hold", () => {
    const head = finalHead("failure", ["tests (serialized 1/2)", "CI result", "main-green"]);
    expect(decide(head, ["CI result"])).toEqual({
      action: "return",
      failedChecks: ["tests (serialized 1/2)", "CI result", "main-green"],
    });
    // An empty list: no check is infrastructure, every final failure goes back.
    expect(decide(finalHead("failure", ["CI result"]), [])).toEqual({ action: "return", failedChecks: ["CI result"] });
  });

  it("lists every failed check once", () => {
    expect(decide(finalHead("failure", ["checks", "checks", "CI result"]))).toEqual({
      action: "return",
      failedChecks: ["checks", "CI result"],
    });
  });
});

describe("readCiReturnHoldMark", () => {
  const mark = { headSha: HEAD, reason: "base_branch_red", failedChecks: ["checks", "main-green"], heldAt: "2026-11-13T07:00:00.000Z" };

  it("reads the mark from work-product metadata", () => {
    expect(readCiReturnHoldMark({ number: 7, [CI_RETURN_HOLD_METADATA_KEY]: mark })).toEqual(mark);
  });

  it("treats anything malformed as no mark", () => {
    expect(readCiReturnHoldMark(null)).toBeNull();
    expect(readCiReturnHoldMark({})).toBeNull();
    expect(readCiReturnHoldMark({ [CI_RETURN_HOLD_METADATA_KEY]: null })).toBeNull();
    expect(readCiReturnHoldMark({ [CI_RETURN_HOLD_METADATA_KEY]: { ...mark, headSha: "" } })).toBeNull();
    expect(readCiReturnHoldMark({ [CI_RETURN_HOLD_METADATA_KEY]: { ...mark, reason: "other" } })).toBeNull();
    expect(readCiReturnHoldMark({ [CI_RETURN_HOLD_METADATA_KEY]: { headSha: HEAD, reason: "ci_infra_only" } })).toEqual({
      headSha: HEAD,
      reason: "ci_infra_only",
      failedChecks: [],
      heldAt: "",
    });
  });
});

describe("notes", () => {
  it("tells in the thread why the task stays in review", () => {
    const base = buildCiReturnHoldNote({ reason: "base_branch_red", headSha: HEAD, failedChecks: ["checks", "main-green"] });
    expect(base).toContain(HEAD.slice(0, 8));
    expect(base).toContain("checks, main-green");
    expect(base).toContain(BASE_BRANCH_RED_CHECK_NAME);
    expect(base).toContain("ci_infra_retry_needed");
    const infra = buildCiReturnHoldNote({ reason: "ci_infra_only", headSha: HEAD, failedChecks: ["CI result"] });
    expect(infra).toContain("CI result");
    expect(infra).toContain("ci_infra_retry_needed");
  });

  it("names the failed checks in the return comment, and the re-run after a base-branch hold", () => {
    expect(buildCiReturnNote({ failedChecks: ["checks", "CI result"], releasedHold: null })).toBe(
      " Failed checks: checks, CI result.",
    );
    const released = buildCiReturnNote({ failedChecks: ["checks", "CI result"], releasedHold: "base_branch_red" });
    expect(released).toContain("Failed checks: checks, CI result.");
    expect(released).toContain("re-run the failed jobs");
    expect(buildCiReturnNote({ failedChecks: [], releasedHold: null })).toBe("");
  });
});
