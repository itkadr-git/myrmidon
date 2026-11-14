// myrmidon(EMPTY-RUNS-2): the executor's comment does not wake the reviewer
// while the review stage waits for green CI.
//
// The hand-off to review goes through the green-CI admission gate (OPE-12176):
// while the `CI result` of the exact pull request head is not green the
// reviewer is not woken, and the board arms its own "Review CI wait" monitor,
// whose tick wakes the stage participant once the head CI is final. The
// comment path knew nothing about that gate. The executor's closing note,
// posted as a separate request seconds after the hand-off, woke the reviewer
// with `issue_commented` straight past it; the reviewer run found an
// unfinished CI, could not record a verdict and ended with one more comment.
// On the release board (12-13.11.2026) 111 of 136 reviewer comment wakes came
// from an engineer's comment, most of them within two minutes of the monitor
// being scheduled.
//
// The gate is deliberately narrow. A comment is held back only when ALL hold:
//
//   - the issue is `in_review` and its review stage is pending;
//   - the wake would go to the stage participant (the reviewer);
//   - the author is the agent that handed the task over (`returnAssignee`);
//   - the board's own "Review CI wait" monitor is armed for the issue. That is
//     the proof that an admission wake is still owed and WILL come, so holding
//     the comment back can never lose the reviewer's wake;
//   - the comment is not an explicit resume and did not reopen the issue;
//   - the admission decision of the status path (`decideReviewAdmission`) says
//     "not yet": the head CI is pending or unreadable, or the head is red.
//
// Everything else wakes as before: a person's comment, another agent's comment
// (a lead's instruction), a comment after the reviewer was admitted (no armed
// monitor), a green head, a critical issue. The comment stays in the thread;
// the reviewer reads it when the admission wake arrives.
//
// No database and no network here: the CI reads are injected by the caller.

import {
  REVIEW_CI_WAIT_MONITOR_SERVICE_NAME,
  decideReviewAdmission,
  type ReviewAdmissionDecision,
} from "./policy.js";
import type { ReviewHeadFailedChecksResolver, ReviewPullRequestCiResolver } from "./github-ci.js";

/** Activity row written for every comment wake the gate held back. */
export const REVIEW_COMMENT_WAKE_DEFERRED_ACTION = "issue.review_comment_wake_deferred";

/** Kill switch. Unset or any value but an explicit off keeps the gate on. */
export const REVIEW_COMMENT_WAKE_GATE_ENABLED_ENV = "MYRMIDON_REVIEW_COMMENT_WAKE_GATE_ENABLED";

/**
 * The gate ships enabled (a defect fix): only an explicit off value turns it
 * off, and then every comment wakes the assignee exactly as before the gate.
 * Same reading as `readReviewReturnGuardEnabled` of the review return guard.
 */
export function readReviewCommentWakeGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[REVIEW_COMMENT_WAKE_GATE_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** A stage principal as the execution state stores it; only these fields are read. */
export type StagePrincipalLike =
  | { type: string; agentId?: string | null; userId?: string | null }
  | null
  | undefined;

/** The part of the parsed execution state the gate reads. */
export interface ReviewStageStateLike {
  status?: string | null;
  currentStageType?: string | null;
  currentParticipant?: StagePrincipalLike;
  returnAssignee?: StagePrincipalLike;
}

export interface ExecutorCommentOnWaitingReviewFacts {
  /** Status of the issue after the comment was written. */
  issueStatus: string | null | undefined;
  /** Parsed `issues.execution_state`; null when there is none or it is unreadable. */
  executionState: ReviewStageStateLike | null | undefined;
  /** Raw `issues.execution_policy`; only `monitor.serviceName` is read. */
  executionPolicy: unknown;
  /** `issues.monitor_next_check_at`: a monitor that is not armed proves nothing. */
  monitorNextCheckAt: Date | string | null | undefined;
  /** The agent the comment wake would go to (the issue assignee). */
  recipientAgentId: string | null | undefined;
  /** Who wrote the comment. */
  authorType: "user" | "agent";
  authorAgentId: string | null | undefined;
  /** The comment reopened the issue. */
  reopened: boolean;
  /** The comment carries an explicit, authorised resume intent. */
  resumeRequested: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The board's "Review CI wait" monitor is armed for the issue: the policy
 * carries the monitor and its next check is scheduled. The monitor dispatcher
 * reads the same two facts, so "armed" here means its tick will run and wake
 * the stage participant once the head CI is final.
 */
export function isReviewCiWaitMonitorArmed(input: {
  executionPolicy: unknown;
  monitorNextCheckAt: Date | string | null | undefined;
}): boolean {
  if (input.monitorNextCheckAt === null || input.monitorNextCheckAt === undefined || input.monitorNextCheckAt === "") {
    return false;
  }
  const monitor = asRecord(asRecord(input.executionPolicy)?.monitor);
  return monitor?.serviceName === REVIEW_CI_WAIT_MONITOR_SERVICE_NAME;
}

/**
 * The structural half of the gate, no CI read: is this the executor's plain
 * comment on a task whose pending review stage still waits for its admission
 * wake? `false` means the comment wakes the assignee exactly as before.
 */
export function isExecutorCommentOnWaitingReview(facts: ExecutorCommentOnWaitingReviewFacts): boolean {
  if (facts.reopened || facts.resumeRequested) return false;
  if (facts.issueStatus !== "in_review") return false;
  if (facts.authorType !== "agent" || !facts.authorAgentId) return false;
  if (!facts.recipientAgentId) return false;
  // A participant that comments on its own stage is a self comment; it is not this gate's case.
  if (facts.authorAgentId === facts.recipientAgentId) return false;

  const state = facts.executionState;
  if (!state || state.status !== "pending" || state.currentStageType !== "review") return false;
  const participant = state.currentParticipant;
  if (!participant || participant.type !== "agent" || participant.agentId !== facts.recipientAgentId) return false;
  const executor = state.returnAssignee;
  if (!executor || executor.type !== "agent" || executor.agentId !== facts.authorAgentId) return false;

  return isReviewCiWaitMonitorArmed(facts);
}

/**
 * The admission decision of the status path for the issue's pull request head,
 * from the same two reads and the same mapping `routes/issues.ts` uses when a
 * task enters review. A critical issue is reviewed in parallel with CI and
 * spends no read. The failed-checks list is read only when the final check of
 * a finished head carries no verdict of its own.
 */
export async function readReviewAdmissionDecision(input: {
  companyId: string;
  issueId: string;
  critical: boolean;
  resolveCi: ReviewPullRequestCiResolver;
  resolveHeadFailedChecks: ReviewHeadFailedChecksResolver;
}): Promise<ReviewAdmissionDecision> {
  if (input.critical) return "admit";
  const ci = await input.resolveCi({ companyId: input.companyId, issueId: input.issueId });
  let headFinalCheck: "green" | "red" | "unknown" = "unknown";
  if (ci.state === "complete") {
    if (ci.finalCheckConclusion === "failure") {
      headFinalCheck = "red";
    } else if (ci.finalCheckConclusion === "success") {
      headFinalCheck = "green";
    } else {
      const headFailed = await input.resolveHeadFailedChecks({
        companyId: input.companyId,
        issueId: input.issueId,
        headSha: ci.headSha ?? "",
      });
      // An unreadable list is "green", exactly as on the status path.
      headFinalCheck =
        headFailed.state === "ok" && headFailed.headSha === ci.headSha && headFailed.failed.length > 0
          ? "red"
          : "green";
    }
  }
  return decideReviewAdmission({ ci: ci.state, headFinalCheck, critical: false });
}
