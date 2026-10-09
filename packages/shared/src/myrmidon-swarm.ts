// packages/shared/src/myrmidon-swarm.ts
//
// myrmidon(1.6.5 OPE-6608 A): the names of the board-side matcher — the pairing
// of a ready task with a free agent of its caste and nest, without a run of the
// model in between (design.md §3).
//
// This file is the home of the rework's shared half. The settings schema of
// design §5.1 (the single `general.swarm` key, no pilot) lands here next to
// these names; the pilot fields of `myrmidon-swarm-claim.ts` are removed there
// once T2 has moved them, so nothing here duplicates that file's work.

/** The wake the matcher posts: the task is already the woken agent's own. */
export const SWARM_MATCHED_WAKE_REASON = "swarm_matched";

/** The mutation the wake carries in its payload (`queueIssueAssignmentWakeup`). */
export const SWARM_MATCHED_MUTATION = "swarm_matched";

/** The wake's context source, so a run can say why it was started. */
export const SWARM_MATCHED_CONTEXT_SOURCE = "swarm_matched";

/** The activity of a match: who took what, and how long the task waited. */
export const SWARM_MATCHED_ACTION = "issue.swarm_matched";

/** A lease released because the assignment it was written for was lost. */
export const SWARM_MATCHED_ASSIGNMENT_LOST_REASON = "swarm_matched_assignment_lost";

/** The lease that expired on a task nobody ever claimed (design §4.1). */
export const SWARM_UNASSIGNED_ON_EXPIRY_ACTION = "issue.swarm_claim.unassigned_on_expiry";

/**
 * One wake per task: a retried pass of the same task carries the same key and
 * the wake layer drops the duplicate, so a task can never start two runs.
 */
export function swarmMatchedIdempotencyKey(issueId: string): string {
  return `swarm_matched:${issueId}`;
}