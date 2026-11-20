// myrmidon(EMPTY-WAKES-CI-UNREADY): no wake for a task whose pull request head
// has no usable CI yet.
//
// Measured on the 1.6.9-rc.12 board, 16.11 17:10-19:07: of 505 successful
// reviewer runs only 149 ended with a verdict (239 found "GitHub rate limit, CI
// unavailable", 64 "the CI of the head is not ready", 28 hit a monitor error);
// of 326 engineer runs only 55 pushed (97 waited for the CI of their own PR,
// 27 hit the same GitHub limit). Every one of these runs was woken by a source
// that did not know the CI state: idle pickup, review recovery, the review
// request, the in-progress idle wake (every 5 minutes).
//
// One decision point for all of them: `enqueueWakeupInner` (heartbeat.ts) asks
// `decideWakeCiGate` before it creates a wake row. The sources keep their own
// earlier filters (idle pickup `reviewCiDefersIdlePickup`); this is the
// net under all of them, so a new source cannot forget the rule.
//
//   Reviewer (the task is `in_review`, the pending review stage names this
//   agent): reasons `idle_pickup`, `execution_review_participant_recovery`,
//   `execution_review_requested` are not delivered while the CI of the current
//   head is pending, or cannot be read (GitHub rate limit or a failed read).
//   Under a rate limit the wake comes back after the reset plus a minute
//   (`resumeAt`); the sources ask again by themselves (the sweep, the review
//   CI wait monitor), so nothing is lost. `ci_completed` is not gated: it is the
//   wake that says the CI of the head is final. A critical task is reviewed in
//   parallel with CI and always passes. A finished CI, red or green, passes
//   (red is the executor's, the status path owns it).
//
//   Engineer (the assignee of an `in_progress` task): reasons `in_progress_no_run`,
//   `issue_continuation_needed` and `idle_pickup` are not delivered while its own
//   PR waits for CI (`issueWaitsForOwnPrCi`: open PR, CI queued or in progress,
//   the record belongs to the CURRENT head, same sign as the swarm load
//   discount `ciWaitingPullRequestIssueIds`). The CI result wakes it. This read
//   is of the board's stored state (webhook), it makes no GitHub call, so a
//   rate limit does not change it.
//
// A manual wake of a person always passes. A switch turns the gate off.

import type { ReviewPullRequestCiResolver } from "./review-stage-recovery/github-ci.js";

export const WAKE_CI_UNREADY_GATE_ENABLED_ENV = "MYRMIDON_WAKE_CI_UNREADY_GATE_ENABLED";

/** Wakes of a review participant that wait for a usable CI of the head. */
export const REVIEWER_CI_GATED_WAKE_REASONS: ReadonlySet<string> = new Set([
  "idle_pickup",
  "execution_review_participant_recovery",
  "execution_review_requested",
]);

/** Wakes of an executor that wait for the CI of its own PR. */
export const ENGINEER_CI_GATED_WAKE_REASONS: ReadonlySet<string> = new Set([
  "in_progress_no_run",
  "issue_continuation_needed",
  "idle_pickup",
]);

/** The wake is held this long after the GitHub limit resets, so the first reads do not hit the edge. */
export const RATE_LIMIT_RESUME_MARGIN_MS = 60_000;

export function readWakeCiUnreadyGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WAKE_CI_UNREADY_GATE_ENABLED_ENV]?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

/** Cheap pre-check before any read: can this reason be held by the gate at all? */
export function isWakeCiGatedReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return REVIEWER_CI_GATED_WAKE_REASONS.has(reason) || ENGINEER_CI_GATED_WAKE_REASONS.has(reason);
}

export type WakeCiGateDecision =
  | { action: "admit" }
  | {
      action: "defer";
      role: "reviewer" | "engineer";
      cause: "ci_pending" | "ci_unreadable" | "rate_limited";
      /** When the wake may come back; null = no fixed time, the source asks again. */
      resumeAt: Date | null;
    };

export interface WakeCiGateIssue {
  id: string;
  status: string | null;
  priority: string | null;
  assigneeAgentId: string | null;
  executionState: unknown;
}

export interface WakeCiGateDeps {
  resolveCi: ReviewPullRequestCiResolver;
  /** `issueWaitsForOwnPrCi` bound to the database. */
  engineerWaitsForOwnPrCi: (companyId: string, issueId: string) => Promise<boolean>;
  isRateLimited: () => boolean;
  rateLimitResetEpochSeconds: () => number | null;
}

function isPendingReviewParticipant(executionState: unknown, agentId: string): boolean {
  if (!executionState || typeof executionState !== "object") return false;
  const es = executionState as Record<string, unknown>;
  if (es.status !== "pending" || es.currentStageType !== "review") return false;
  const participant = es.currentParticipant;
  if (!participant || typeof participant !== "object") return false;
  const p = participant as Record<string, unknown>;
  return p.type === "agent" && p.agentId === agentId;
}

function resumeAfterRateLimit(deps: WakeCiGateDeps): Date | null {
  const reset = deps.rateLimitResetEpochSeconds();
  return reset === null ? null : new Date(reset * 1000 + RATE_LIMIT_RESUME_MARGIN_MS);
}

export async function decideWakeCiGate(
  input: {
    agentId: string;
    companyId: string;
    reason: string;
    issue: WakeCiGateIssue;
  },
  deps: WakeCiGateDeps,
): Promise<WakeCiGateDecision> {
  const { agentId, companyId, reason, issue } = input;

  if (REVIEWER_CI_GATED_WAKE_REASONS.has(reason) && isPendingReviewParticipant(issue.executionState, agentId)) {
    if (issue.priority === "critical") return { action: "admit" };
    if (deps.isRateLimited()) {
      return { action: "defer", role: "reviewer", cause: "rate_limited", resumeAt: resumeAfterRateLimit(deps) };
    }
    let ci;
    try {
      ci = await deps.resolveCi({ companyId, issueId: issue.id });
    } catch {
      return { action: "defer", role: "reviewer", cause: "ci_unreadable", resumeAt: null };
    }
    if (ci.state === "pending") {
      return { action: "defer", role: "reviewer", cause: "ci_pending", resumeAt: null };
    }
    if (ci.state === "unknown") {
      // The read itself may have hit the limit after the check above.
      if (ci.rateLimit || deps.isRateLimited()) {
        return { action: "defer", role: "reviewer", cause: "rate_limited", resumeAt: resumeAfterRateLimit(deps) };
      }
      return { action: "defer", role: "reviewer", cause: "ci_unreadable", resumeAt: null };
    }
    return { action: "admit" };
  }

  if (
    ENGINEER_CI_GATED_WAKE_REASONS.has(reason) &&
    issue.status === "in_progress" &&
    issue.assigneeAgentId === agentId &&
    !isPendingReviewParticipant(issue.executionState, agentId)
  ) {
    try {
      if (await deps.engineerWaitsForOwnPrCi(companyId, issue.id)) {
        return { action: "defer", role: "engineer", cause: "ci_pending", resumeAt: null };
      }
    } catch {
      return { action: "admit" };
    }
  }
  return { action: "admit" };
}
