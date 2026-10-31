// myrmidon(OPE-10045): what the board does when a reviewer run ends while an
// execution-review stage is still pending and no decision was recorded.
//
// Before this module the release tail retried the reviewer once and then moved
// the task to `blocked` with a board escalation (`board_escalation_no_takeover_v1`).
// On the release board that produced ~290 blocks a day, and most of them were
// not stalls at all:
//
//   - the reviewer was waiting for CI on the PR head (pending/queued checks);
//   - the reviewer had approved, but `done` was refused by the PR gate because
//     the PR was not merged yet (handled by the pre-merge approval in the PATCH
//     route, see `pre-merge-approval.ts`);
//   - the reviewer wrote the verdict as a comment only.
//
// This file holds the pure half: the constants, the instructions the reviewer
// sees, and the decision between "wait for CI", "wake the reviewer once more
// with an explicit instruction" and "escalate". No database and no network.

/** Monitor service name of the CI wait; the monitor dispatcher wakes the stage participant for it. */
export const REVIEW_CI_WAIT_MONITOR_SERVICE_NAME = "Review CI wait";

/** How long the board waits before it looks at the PR head CI again. */
export const REVIEW_CI_WAIT_INTERVAL_MS = 10 * 60 * 1000;

/** CI waits per review stage (18 x 10 min = 3 h); afterwards the normal retry/escalation applies. */
export const REVIEW_CI_WAIT_MAX_ATTEMPTS = 18;

/**
 * Reviewer re-wakes for a missing decision before the board escalation. The
 * first one is the release tail's own review-participant recovery run; the
 * board adds the rest with the explicit decision instruction.
 */
export const REVIEW_DECISION_MAX_REWAKES = 2;

/** Window in which earlier deferrals of the same stage are counted. */
export const REVIEW_STAGE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Activity row written for every deferral; the counters above are read back from it. */
export const REVIEW_STAGE_RECOVERY_DEFERRED_ACTION = "issue.review_stage_recovery_deferred";

export const REVIEW_DECISION_RECOVERY_INSTRUCTION =
  "Submit the review decision now: PATCH the issue with status=in_progress and a comment to return it for changes, " +
  "or with status=done and a comment to approve it. An approval given before the pull request is merged is recorded " +
  "and the task closes after the merge. A verdict written only as a comment is not a decision. " +
  "If you cannot decide, mark the issue blocked with the exact unblock action.";

export const REVIEW_CI_WAIT_RECOVERY_INSTRUCTION =
  "The board waited for CI on the pull request head. Check the current CI result of the head commit, then submit " +
  "the review decision now: PATCH status=in_progress with a comment to return it, or status=done with a comment to " +
  "approve it. If CI is still running, end the run without a decision; the board checks CI again.";

/**
 * Name of the aggregate check of the Myrmidon CI workflow (`ci-result` job of
 * myrmidon-ci.yml). It is created only after every lane it needs has finished,
 * so while it is missing the CI of the head is still running, however many
 * other checks (`checks`, `freeze`, ...) have already failed.
 */
export const REVIEW_CI_FINAL_CHECK_NAME = "CI result";

/** CI on the head of the issue's open pull request, as far as the board can read it. */
export type ReviewPullRequestCiState =
  /** The final `CI result` check of the head is missing or not completed yet. */
  | "pending"
  /** The final `CI result` check of the head is completed (whatever its conclusion). */
  | "complete"
  /**
   * The board could not read the head (no token, network or GitHub error). It
   * is treated like "pending": the review waits, bounded by the same attempts,
   * and the reason is logged.
   */
  | "unknown"
  /** The issue has no open pull request work product. */
  | "no_pull_request";

export interface ReviewPullRequestCiFacts {
  state: ReviewPullRequestCiState;
  pullRequestUrl: string | null;
  headSha: string | null;
  /** Why the state is "unknown"; a short code, never a token or a header. */
  reason?: string | null;
}

export interface StalledReviewRecoveryFacts {
  ci: ReviewPullRequestCiState;
  /** CI waits already scheduled for this stage in the window. */
  ciWaitsUsed: number;
  /** Decision re-wakes already spent on this stage (the release tail's own retry included). */
  decisionRewakesUsed: number;
}

export type StalledReviewRecoveryDecision =
  | { kind: "wait_for_ci"; attempt: number; maxAttempts: number }
  | { kind: "retry_decision"; attempt: number; maxAttempts: number }
  | { kind: "escalate"; reason: "ci_wait_exhausted" | "decision_retries_exhausted" };

/** A CI the board cannot read is waited for exactly like a CI that is still running. */
export function isReviewCiWaiting(ci: ReviewPullRequestCiState): boolean {
  return ci === "pending" || ci === "unknown";
}

export function decideStalledReviewRecovery(facts: StalledReviewRecoveryFacts): StalledReviewRecoveryDecision {
  const waiting = isReviewCiWaiting(facts.ci);
  if (waiting && facts.ciWaitsUsed < REVIEW_CI_WAIT_MAX_ATTEMPTS) {
    return { kind: "wait_for_ci", attempt: facts.ciWaitsUsed + 1, maxAttempts: REVIEW_CI_WAIT_MAX_ATTEMPTS };
  }
  if (facts.decisionRewakesUsed < REVIEW_DECISION_MAX_REWAKES) {
    return { kind: "retry_decision", attempt: facts.decisionRewakesUsed + 1, maxAttempts: REVIEW_DECISION_MAX_REWAKES };
  }
  return {
    kind: "escalate",
    reason: waiting ? "ci_wait_exhausted" : "decision_retries_exhausted",
  };
}

/** Counts the earlier deferrals of one stage from the activity rows this module writes. */
export function countStalledReviewDeferrals(
  rows: ReadonlyArray<{ details: unknown }>,
  stageId: string | null,
): { ciWaits: number; decisionRetries: number } {
  let ciWaits = 0;
  let decisionRetries = 0;
  for (const row of rows) {
    const details = row.details && typeof row.details === "object" && !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : null;
    if (!details) continue;
    if ((details.stageId ?? null) !== stageId) continue;
    if (details.kind === "ci_wait") ciWaits += 1;
    else if (details.kind === "decision_retry") decisionRetries += 1;
  }
  return { ciWaits, decisionRetries };
}

/** Work-product statuses of a pull request that is still open (not merged, closed or superseded). */
export const OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "draft",
  "active",
  "ready_for_review",
  "approved",
  "changes_requested",
]);

type PullRequestProductLike = {
  type: string;
  status: string;
  isPrimary?: boolean | null;
  updatedAt?: Date | string | null;
};

function timeOf(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

/** The issue's open pull request: the primary one when it is open, otherwise the most recently updated. */
export function selectOpenPullRequestWorkProduct<T extends PullRequestProductLike>(products: readonly T[]): T | null {
  const open = products.filter(
    (product) => product.type === "pull_request" && OPEN_PULL_REQUEST_WORK_PRODUCT_STATUSES.has(product.status),
  );
  if (open.length === 0) return null;
  const primary = open.find((product) => product.isPrimary === true);
  if (primary) return primary;
  return [...open].sort((left, right) => timeOf(right.updatedAt) - timeOf(left.updatedAt))[0] ?? null;
}

const FINISHED_CHECK_RUN_STATUS = "completed";

/**
 * Conclusions of a completed `CI result` that are not a verdict on the head.
 * GitHub keeps the check runs of earlier, superseded workflow runs on the same
 * head: a run cancelled by a newer one (or skipped by the label-only runs)
 * reports `CI result` as completed/cancelled|skipped while the run that
 * matters is still queued.
 */
const NOT_A_VERDICT_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled", "skipped", "stale"]);

/**
 * CI state of one head commit from its check runs. CI of the head is finished
 * only when the final `CI result` check exists and is completed: the other
 * checks are ignored, so a failed `checks` or `freeze` with `typecheck` and
 * `tests` still queued is not a finished CI. A missing check list means the
 * read failed: "unknown".
 */
export function pullRequestHeadCiStateFromChecks(input: {
  checkRuns: readonly unknown[] | null;
}): "pending" | "complete" | "unknown" {
  if (!input.checkRuns) return "unknown";
  const finished = input.checkRuns.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const run = entry as Record<string, unknown>;
    if (run.name !== REVIEW_CI_FINAL_CHECK_NAME) return false;
    if (run.status !== FINISHED_CHECK_RUN_STATUS) return false;
    return !(typeof run.conclusion === "string" && NOT_A_VERDICT_CONCLUSIONS.has(run.conclusion));
  });
  return finished ? "complete" : "pending";
}
