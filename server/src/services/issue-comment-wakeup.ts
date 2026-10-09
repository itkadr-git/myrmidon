/**
 * Whether a comment on an issue wakes the assignee.
 *
 * `suppressesWake` is the myrmidon(1.6.5 PROMPT-BUDGET-SIGNAL) guard: a system
 * prompt-budget notice — the signal the board used to write into the agent's
 * most recent in_progress task, 17 copies in two hours on the live board — is
 * not a message for the agent whose prompt is already over budget. The copies
 * already in threads must not wake anyone, so the guard rides here, where every
 * comment wake is decided, and the wake path passes it `isPromptBudgetSignalNotice`
 * over the comment row.
 */
export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  currentStatus: string | null | undefined;
  suppressesWake?: boolean;
}) {
  if (input.suppressesWake) {
    return false;
  }
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
