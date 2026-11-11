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

/**
 * myrmidon(OPE-12177): the idempotency-key namespace of review-admission
 * wakeups. The key deduplicates wakes per issue, so every writer must build it
 * with `reviewAdmissionDedupKey` — never interpolate a custom tail.
 */
export const REVIEW_ADMISSION_KEY_PREFIX = "issue-review-admission:";

/**
 * myrmidon(OPE-12177): dedup key of a review-admission wake. The tail is the
 * exact PR head the admission decision was made on, so the same head never
 * wakes the reviewer twice (idempotency) while a pushed fix — a new head —
 * produces a fresh key and a fresh wake. Without a head SHA (no PR work
 * product, or a board that cannot read one) the legacy agent-keyed format is
 * kept, so those boards dedup exactly as before.
 */
export function reviewAdmissionDedupKey(input: {
  issueId: string;
  headSha?: string | null;
  agentId: string;
}): string {
  const headSha = typeof input.headSha === "string" ? input.headSha.trim() : "";
  return headSha
    ? `${REVIEW_ADMISSION_KEY_PREFIX}${input.issueId}:${headSha}`
    : `${REVIEW_ADMISSION_KEY_PREFIX}${input.issueId}:${input.agentId}`;
}

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
  /** No hosted CI workflows are configured in this repository. */
  | "not_configured"
  /** The issue has no open pull request work product. */
  | "no_pull_request";

export interface ReviewPullRequestCiFacts {
  state: ReviewPullRequestCiState;
  pullRequestUrl: string | null;
  headSha: string | null;
  /** The authoritative final `CI result` check's conclusion, when complete. */
  finalCheckConclusion?: string | null;
  /** Why the state is "unknown"; a short code, never a token or a header. */
  reason?: string | null;
  /**
   * Present when GitHub answered a rate limit while reading: the measured
   * budget of the installation/IP (OPE-10246). Numbers from the
   * `x-ratelimit-*` response headers, never a token.
   */
  rateLimit?: {
    remaining: number | null;
    limit: number | null;
    /** Epoch seconds of `x-ratelimit-reset`; null when GitHub did not send it. */
    resetEpochSeconds: number | null;
  } | null;
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

/**
 * myrmidon(OPE-12176): may the reviewer of a task be woken now? A reviewer is
 * admitted only when the `CI result` check of the exact head is green: while CI
 * is still running (or unreadable) the review waits for CI, and a finished head
 * with a red check waits for the fix instead of waking a reviewer onto a known
 * red head. A critical issue keeps the old behaviour and reviews in parallel
 * with CI.
 */
export type ReviewAdmissionDecision = "admit" | "wait_for_ci" | "wait_red";

export interface ReviewAdmissionFacts {
  /** CI of the exact head the review decision is made on. */
  ci: ReviewPullRequestCiState;
  /** Result of the exact-head `CI result` check, if CI has completed. */
  headFinalCheck: "green" | "red" | "unknown";
  /** A critical issue is reviewed in parallel with CI. */
  critical: boolean;
}

export function decideReviewAdmission(facts: ReviewAdmissionFacts): ReviewAdmissionDecision {
  if (facts.critical) return "admit";
  if (isReviewCiWaiting(facts.ci)) return "wait_for_ci";
  if (facts.ci === "complete" && facts.headFinalCheck === "unknown") return "wait_for_ci";
  if (facts.ci === "complete" && facts.headFinalCheck === "red") return "wait_red";
  return "admit";
}

/** Error code of a run the maintenance drain interrupted (myrmidon/maintenance/domain.ts). */
const MAINTENANCE_INTERRUPTED_ERROR_CODE = "myrmidon_maintenance_interrupted";

/**
 * myrmidon(OPE-12201): the maintenance drain of a deploy interrupted this run
 * (cancelled with the maintenance code). That is not a reviewer that failed to
 * decide: the recovery re-wakes it without spending the decision budget, and
 * the activity row carries kind "maintenance_retry", which the counter below
 * does not count.
 */
export function isMaintenanceInterruptedRun(
  run: { status: string; errorCode?: string | null } | null | undefined,
): boolean {
  return run?.status === "cancelled" && run.errorCode === MAINTENANCE_INTERRUPTED_ERROR_CODE;
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
 * CI state of one head commit from ALL of its check runs (the latest run of
 * every check name). Repositories without the aggregate `CI result` check
 * (anything that is not the Myrmidon workflow) still have a finished CI: it is
 * the moment when no check of the head is queued, in progress or waiting
 * anymore. Whatever the conclusions, a finished CI is a verdict the reviewer
 * may act on; zero check runs means CI has not started yet.
 * A missing check list means the read failed: "unknown".
 */
export function pullRequestHeadCiStateFromAllChecks(input: {
  checkRuns: readonly unknown[] | null;
}): "pending" | "complete" | "unknown" {
  if (!input.checkRuns) return "unknown";
  if (input.checkRuns.length === 0) return "pending";
  const allFinished = input.checkRuns.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const run = entry as Record<string, unknown>;
    return run.status === FINISHED_CHECK_RUN_STATUS;
  });
  return allFinished ? "complete" : "pending";
}

/**
 * CI state of one head commit from its check runs. CI of the head is finished
 * only when the final `CI result` check exists, belongs to exactly this head
 * (`head_sha` of the record matches) and is completed: the other checks are
 * ignored, so a failed `checks` or `freeze` with `typecheck` and
 * `tests` still queued is not a finished CI. A missing check list means the
 * read failed: "unknown".
 *
 * OPE-12175: the gate that starts a reviewer and the dedup key both work on
 * the exact head SHA, so a completed `CI result` left over from a superseded
 * head must never open the review. Records without `head_sha` (or with a
 * different one) are treated as not belonging to this head.
 */
export function pullRequestHeadFinalCheckConclusion(input: {
  checkRuns: readonly unknown[] | null;
  headSha?: string;
}): string | null {
  if (!input.checkRuns) return null;
  for (const entry of input.checkRuns) {
    if (!entry || typeof entry !== "object") continue;
    const run = entry as Record<string, unknown>;
    if (run.name !== REVIEW_CI_FINAL_CHECK_NAME || run.status !== FINISHED_CHECK_RUN_STATUS) continue;
    if (input.headSha && run.head_sha !== input.headSha) continue;
    if (typeof run.conclusion !== "string" || NOT_A_VERDICT_CONCLUSIONS.has(run.conclusion)) continue;
    return run.conclusion;
  }
  return null;
}

export function pullRequestHeadCiStateFromChecks(input: {
  checkRuns: readonly unknown[] | null;
  headSha: string;
}): "pending" | "complete" | "unknown" {
  if (!input.checkRuns) return "unknown";
  const finished = input.checkRuns.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const run = entry as Record<string, unknown>;
    if (run.name !== REVIEW_CI_FINAL_CHECK_NAME) return false;
    if (run.head_sha !== input.headSha) return false;
    if (run.status !== FINISHED_CHECK_RUN_STATUS) return false;
    return !(typeof run.conclusion === "string" && NOT_A_VERDICT_CONCLUSIONS.has(run.conclusion));
  });
  return finished ? "complete" : "pending";
}
