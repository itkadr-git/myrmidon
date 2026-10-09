import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });

  // myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL): the signal for the owner and the
  // operator used to be a system notice in the agent's own task, and every
  // copy woke that agent — 17 of them in two hours on the live board, queued
  // as the agent's new messages while its prompt was already over budget. The
  // copies still in threads must not wake anyone, whatever the issue status.
  it("never wakes on a prompt-budget signal notice", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      commentCreatedByRunId: null,
      issueAtCommentStart: {},
      reopened: false,
      suppressesWake: true,
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, currentStatus: "in_progress" }),
    ).toBe(false);
    // Even a reopen of the issue by the notice wakes nobody.
    expect(
      shouldWakeAssigneeForIssueComment({
        ...base,
        reopened: true,
        currentStatus: "done",
      }),
    ).toBe(false);
  });
});
