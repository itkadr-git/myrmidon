import { describe, expect, it, vi } from "vitest";
import type {
  ReviewHeadFailedChecks,
  ReviewHeadFailedChecksResolver,
} from "../review-stage-recovery/github-ci.js";
import {
  decideReviewReturnWake,
  recordSuppressedReviewReturn,
  type ReviewReturnGuardInput,
  type SuppressedReturnRecordPorts,
} from "./guard.js";
import { CI_INFRA_RETRY_NEEDED_ACTION, REVIEW_RETURN_SUPPRESSED_ACTION } from "./policy.js";

const HEAD_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const HEAD_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334";
const PR_URL = "https://github.com/acme/app/pull/7";
const CODE_COMMENT = "REQUEST CHANGES: the retry loop never gives up on a closed socket";
const CI_COMMENT = "REQUEST CHANGES: exact-head CI is terminal FAILURE: CI result and main-green failed.";

function resolver(result: ReviewHeadFailedChecks | Error) {
  return vi.fn<ReviewHeadFailedChecksResolver>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

function input(overrides: Partial<ReviewReturnGuardInput> = {}): ReviewReturnGuardInput {
  return {
    enabled: true,
    companyId: "company-1",
    issueId: "issue-1",
    previousState: { status: "pending" },
    nextState: { status: "changes_requested", lastChangesRequestedHeadSha: HEAD_A },
    commentBody: CODE_COMMENT,
    infraCheckNames: ["CI result", "main-green"],
    ...overrides,
  };
}

describe("decideReviewReturnWake: same head", () => {
  it("does not wake the executor for a second return on the same head without a new commit", async () => {
    const resolveFailedChecks = resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] });
    const decision = await decideReviewReturnWake(
      input({
        previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_A },
        // A code review comment: the repeat rule does not look at the comment.
        commentBody: CODE_COMMENT,
      }),
      { resolveFailedChecks },
    );

    expect(decision).toEqual({ action: "suppress", reason: "repeat_same_head", headSha: HEAD_A });
    expect(resolveFailedChecks).not.toHaveBeenCalled();
  });

  it("wakes the executor for the first return", async () => {
    const decision = await decideReviewReturnWake(input(), {
      resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }),
    });

    expect(decision).toEqual({ action: "wake" });
  });

  it("wakes the executor when a new commit changed the head since the previous return", async () => {
    const decision = await decideReviewReturnWake(
      input({
        previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_B },
        nextState: { status: "changes_requested", lastChangesRequestedHeadSha: HEAD_A },
      }),
      { resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }) },
    );

    expect(decision).toEqual({ action: "wake" });
  });

  it("wakes the executor for code findings on a new head, even when the old head had a return", async () => {
    const resolveFailedChecks = resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: ["CI result"] });
    const decision = await decideReviewReturnWake(
      input({
        previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_B },
        commentBody: "CI result failed, and server/src/routes/issues.ts:120 drops the retry counter",
      }),
      { resolveFailedChecks },
    );

    expect(decision).toEqual({ action: "wake" });
    // Code findings are never read as an infrastructure report.
    expect(resolveFailedChecks).not.toHaveBeenCalled();
  });

  it("wakes the executor when the head of the return is unknown", async () => {
    const decision = await decideReviewReturnWake(
      input({
        previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_A },
        nextState: { status: "changes_requested" },
      }),
      { resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }) },
    );

    expect(decision).toEqual({ action: "wake" });
  });

  it("wakes the executor when the new state is not a return", async () => {
    for (const nextState of [null, undefined, { status: "pending", lastChangesRequestedHeadSha: HEAD_A }]) {
      const decision = await decideReviewReturnWake(
        input({ previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_A }, nextState }),
        { resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }) },
      );
      expect(decision).toEqual({ action: "wake" });
    }
  });

  it("wakes the executor when the guard is off", async () => {
    const decision = await decideReviewReturnWake(
      input({ enabled: false, previousState: { status: "pending", lastChangesRequestedHeadSha: HEAD_A } }),
      { resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }) },
    );

    expect(decision).toEqual({ action: "wake" });
  });
});

describe("decideReviewReturnWake: infrastructure checks only", () => {
  it("does not wake the executor when every failed check is infrastructure and the comment reports only CI", async () => {
    const resolveFailedChecks = resolver({
      state: "ok",
      headSha: HEAD_A,
      pullRequestUrl: PR_URL,
      failed: ["CI result", "main-green"],
    });
    const decision = await decideReviewReturnWake(input({ commentBody: CI_COMMENT }), { resolveFailedChecks });

    expect(decision).toEqual({
      action: "suppress",
      reason: "ci_infra_only",
      headSha: HEAD_A,
      failedChecks: ["CI result", "main-green"],
      pullRequestUrl: PR_URL,
    });
    expect(resolveFailedChecks).toHaveBeenCalledWith({ companyId: "company-1", issueId: "issue-1", headSha: HEAD_A });
  });

  it("wakes the executor when a lane of the code failed too", async () => {
    const decision = await decideReviewReturnWake(input({ commentBody: CI_COMMENT }), {
      resolveFailedChecks: resolver({
        state: "ok",
        headSha: HEAD_A,
        pullRequestUrl: PR_URL,
        failed: ["tests (affected)", "CI result"],
      }),
    });

    expect(decision).toEqual({ action: "wake" });
  });

  it("wakes the executor when no failed check is found (the reviewer's CI claim cannot be confirmed)", async () => {
    const decision = await decideReviewReturnWake(input({ commentBody: CI_COMMENT }), {
      resolveFailedChecks: resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: [] }),
    });

    expect(decision).toEqual({ action: "wake" });
  });

  it("wakes the executor when the check runs cannot be read", async () => {
    const unreadable = await decideReviewReturnWake(input({ commentBody: CI_COMMENT }), {
      resolveFailedChecks: resolver({ state: "unknown", reason: "check_runs:http_403" }),
    });
    const failing = await decideReviewReturnWake(input({ commentBody: CI_COMMENT }), {
      resolveFailedChecks: resolver(new Error("network down")),
    });

    expect(unreadable).toEqual({ action: "wake" });
    expect(failing).toEqual({ action: "wake" });
  });

  it("does not read the checks when no infrastructure check is configured", async () => {
    const resolveFailedChecks = resolver({ state: "ok", headSha: HEAD_A, pullRequestUrl: PR_URL, failed: ["CI result"] });
    const decision = await decideReviewReturnWake(input({ commentBody: CI_COMMENT, infraCheckNames: [] }), {
      resolveFailedChecks,
    });

    expect(decision).toEqual({ action: "wake" });
    expect(resolveFailedChecks).not.toHaveBeenCalled();
  });
});

describe("recordSuppressedReviewReturn", () => {
  function ports() {
    return {
      addSystemComment: vi.fn<SuppressedReturnRecordPorts["addSystemComment"]>(async () => undefined),
      logActivity: vi.fn<SuppressedReturnRecordPorts["logActivity"]>(async () => undefined),
    };
  }

  it("leaves a note and one activity row for a repeated return", async () => {
    const recording = ports();
    await recordSuppressedReviewReturn(recording, {
      companyId: "company-1",
      issueId: "issue-1",
      identifier: "OPE-1",
      decisionId: "decision-1",
      decision: { action: "suppress", reason: "repeat_same_head", headSha: HEAD_A },
    });

    expect(recording.addSystemComment).toHaveBeenCalledTimes(1);
    expect(recording.addSystemComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("Повторный возврат на той же голове PR"),
    );
    expect(recording.logActivity).toHaveBeenCalledTimes(1);
    expect(recording.logActivity).toHaveBeenCalledWith({
      companyId: "company-1",
      action: REVIEW_RETURN_SUPPRESSED_ACTION,
      entityId: "issue-1",
      details: {
        issueId: "issue-1",
        identifier: "OPE-1",
        decisionId: "decision-1",
        headSha: HEAD_A,
        reason: "repeat_same_head",
      },
    });
  });

  it("also records ci_infra_retry_needed for an infrastructure-only return", async () => {
    const recording = ports();
    await recordSuppressedReviewReturn(recording, {
      companyId: "company-1",
      issueId: "issue-1",
      decision: {
        action: "suppress",
        reason: "ci_infra_only",
        headSha: HEAD_A,
        failedChecks: ["CI result"],
        pullRequestUrl: PR_URL,
      },
    });

    expect(recording.addSystemComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("ci_infra_retry_needed"),
    );
    const actions = recording.logActivity.mock.calls.map(([entry]) => entry.action);
    expect(actions).toEqual([REVIEW_RETURN_SUPPRESSED_ACTION, CI_INFRA_RETRY_NEEDED_ACTION]);
    expect(recording.logActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          headSha: HEAD_A,
          failedChecks: ["CI result"],
          pullRequestUrl: PR_URL,
          reason: "ci_infra_only",
        }),
      }),
    );
  });
});
