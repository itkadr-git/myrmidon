// myrmidon(REVIEW-ROUTING): the pure decisions of the PR lane — what a green
// head means, when a review/steward task is due, when an open routed task is
// superseded, who is eligible. No database and no clock here; the sweep feeds
// these functions (the same shape as policy.ts, which stays the task-lane half).

import { REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY, REVIEW_ROUTING_PR_KIND_METADATA_KEY } from "@paperclipai/shared";

/** The per-head CI/review state the github.ts resolver reads off GitHub. */
export type PullRequestHeadCiState = "green" | "not_green" | "unknown";
export type PullRequestReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "BLOCKED" | null;

export interface PrRef {
  /** "owner/repo" as GitHub spells it. */
  repository: string;
  number: number;
}

export interface PullRequestHeadState extends PrRef {
  /** The PR is open (not closed/merged). */
  open: boolean;
  draft: boolean;
  /** The PR head sha this state was resolved for (authoritative, read from GitHub). */
  headSha: string | null;
  ci: PullRequestHeadCiState;
  reviewDecision: PullRequestReviewDecision;
  fetchFailed: boolean;
  /** Present when the PR body was read (title, link, author, base for the task text). */
  title?: string | null;
  url?: string | null;
  authorLogin?: string | null;
  baseRef?: string | null;
}

/** The board-side view of an open pr-routing task, for coverage and supersede. */
export interface PrRoutedTask {
  issueId: string;
  repository: string;
  number: number;
  kind: "review" | "merge";
  /** The head sha recorded on the work product when the task was created. */
  headSha: string | null;
}

/**
 * The review-task trigger of the PR lane: an open, non-draft PR whose current
 * head is green and carries no review decision. The resolver derives the
 * decision from the PR reviews list (latest verdict per reviewer on the
 * current head); no verdict is `null`. A decision made on an OLDER head never
 * suppresses this — the resolver reports the decision it read for the CURRENT
 * head only, and `reviewDecision !== null` therefore always means "a verdict
 * exists on this head". An unknown head (fetch failure) never triggers: a
 * GitHub outage must not create or close tasks.
 */
export function reviewTaskDueForHead(head: PullRequestHeadState): boolean {
  if (!head.open || head.draft) return false;
  if (head.fetchFailed || head.ci !== "green") return false;
  return head.reviewDecision === null;
}

/** The steward trigger: open, green, APPROVED on the current head. */
export function stewardTaskDueForHead(head: PullRequestHeadState): boolean {
  if (!head.open) return false;
  if (head.fetchFailed || head.ci !== "green") return false;
  return head.reviewDecision === "APPROVED";
}

/**
 * myrmidon(UPDATE-BRANCH-STEWARD): the command that brings the PR head up to
 * date with its base. This is GitHub's
 * `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` — exactly what
 * `gh pr update-branch` runs. On a branch that is already current it is a
 * no-op (GitHub answers "branch is already up to date"), so refreshing is
 * always safe and can be issued unconditionally before landing.
 */
export function stewardUpdateBranchCommand(head: PullRequestHeadState): string {
  return `gh pr update-branch ${head.repository}#${head.number}`;
}

/**
 * myrmidon(UPDATE-BRANCH-STEWARD): the landing command, run only after the
 * refreshed head went green. The refresh happens here, in the open, by the
 * steward itself — the lane never hands the wait over to GitHub.
 */
export function stewardMergeCommand(head: PullRequestHeadState): string {
  return `gh pr merge ${head.repository}#${head.number} --merge`;
}

/**
 * Supersede decision: an open routed task belongs to a head that no longer
 * exists — its recorded head differs from the PR's current head — so it is
 * cancelled and the current head gets its own task by the due rules above.
 * A task without a recorded head was not written by this lane's contract and
 * is left alone; equal heads never supersede.
 */
export function prTaskIsSuperseded(task: PrRoutedTask, currentHeadSha: string): boolean {
  if (task.headSha === null) return false;
  return task.headSha !== currentHeadSha;
}

/** One "review" | "merge" coverage slot for (repository, number, kind). */
export function prRoutingCoverageKey(input: PrRef & { kind: "review" | "merge" }): string {
  return `${input.repository}#${input.number}:${input.kind}`;
}

/** Reads a task's pr-routing coverage from its pull_request work-product metadata. */
export function readPrRoutingWorkProduct(workProduct: {
  type: string;
  metadata?: Record<string, unknown> | null;
}): PrRoutedTask | null {
  if (workProduct.type !== "pull_request") return null;
  const metadata = workProduct.metadata;
  if (!metadata) return null;
  const kind = metadata[REVIEW_ROUTING_PR_KIND_METADATA_KEY];
  if (kind !== "review" && kind !== "merge") return null;
  const repository = typeof metadata.repo === "string" ? metadata.repo : null;
  const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) && metadata.number > 0
    ? metadata.number
    : null;
  if (!repository || number === null) return null;
  const headSha =
    typeof metadata[REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY] === "string"
      ? (metadata[REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY] as string)
      : null;
  return { issueId: "", repository, number, kind, headSha };
}

/** True when the reviewer is already at an open-PR-review ceiling of this lane. */
export function reviewerIsOverPrReviewLoad(input: { openReviewTasks: number; maxOpenReviewsPerReviewer: number }): boolean {
  return input.openReviewTasks >= input.maxOpenReviewsPerReviewer;
}

/** Task titles stay short: the PR title is truncated to 80 characters. */
export const PR_TASK_TITLE_LENGTH = 80;

export function prReviewTaskTitle(head: PullRequestHeadState): string {
  const base = `Review PR ${head.repository}#${head.number}`;
  const title = (head.title ?? "").trim();
  if (!title) return base;
  return `${base}: ${title.slice(0, PR_TASK_TITLE_LENGTH)}`;
}

export function prStewardTaskTitle(head: PullRequestHeadState): string {
  return `Merge PR ${head.repository}#${head.number}`;
}

/** The description names the coordinates and the single line that says why this exists. */
export function prRoutingTaskDescription(head: PullRequestHeadState, kind: "review" | "merge"): string {
  const trigger =
    kind === "review"
      ? "automatic PR review routing — green head without a review verdict"
      : "automatic PR review routing — approved green head awaiting merge";
  const lines = [
    head.url ? `PR: ${head.url}` : `PR: ${head.repository}#${head.number}`,
    head.headSha ? `Head: ${head.headSha}` : "Head: (unknown)",
    head.authorLogin ? `Author: ${head.authorLogin}` : "Author: (unknown)",
    head.baseRef ? `Base: ${head.baseRef}` : "Base: (unknown)",
    trigger,
  ];
  if (kind === "merge") {
    // myrmidon(UPDATE-BRANCH-STEWARD): the steward lands the PR in the open:
    // refresh the head onto the base, wait for the refreshed head's CI, then
    // merge. Update-branch plus the green-on-latest-head rule is what keeps
    // main green after the merge.
    lines.push(
      "Landing path (update-branch steward):",
      `1. Refresh the head onto its base: run \`${stewardUpdateBranchCommand(head)}\`. An already-current branch answers as a no-op, so run it even when the head looks fresh.`,
      "2. Wait for the refreshed head to go green: the update-branch push moves the PR head, the old head's CI verdict no longer covers the merge, and the board cancels this task as superseded — so finish the job on THIS task only if the branch was already current. If the head moved, stop here: the lane routes the refreshed head (review verdict, green CI) and a new steward task merges it.",
      `3. Merge: run \`${stewardMergeCommand(head)}\` once the CURRENT head is green, then mark this task done.`,
      "Do NOT merge a head that is not the PR's current head, and do not skip step 1: `main-protection` refuses a merge whose branch is behind, and the run that catches a real regression is the CI on the refreshed head — not a direct merge of a stale one.",
    );
  }
  return lines.join("\n");
}
