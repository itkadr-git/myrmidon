// myrmidon(OPE-13097): on reassignment, decide whether the run holding the
// issue's execution lock is a not-started run of the previous assignee that
// must be cancelled so the new assignee's wake is not parked in
// `deferred_issue_execution`.

export type ReassignmentHolderRun = {
  id: string;
  agentId: string;
  status: string;
};

export type ReassignmentHolderIssue = {
  status: string;
  assigneeAgentId: string | null;
  executionState?: unknown;
};

const NOT_STARTED_STATUSES = new Set(["queued", "scheduled_retry"]);

export function shouldCancelNotStartedHolderOnReassignment(
  issue: ReassignmentHolderIssue,
  run: ReassignmentHolderRun | null | undefined,
): boolean {
  if (!run || !issue.assigneeAgentId) return false;
  if (!NOT_STARTED_STATUSES.has(run.status)) return false;
  if (run.agentId !== issue.assigneeAgentId) return false;
  // OPE-10582: a review-stage participant's run is not stale.
  if (issue.status === "in_review") {
    const es = issue.executionState as Record<string, unknown> | null | undefined;
    const cp =
      es && typeof es === "object"
        ? (es.currentParticipant as Record<string, unknown> | null | undefined)
        : null;
    if (cp?.type === "agent" && cp.agentId === run.agentId) return false;
  }
  return true;
}
