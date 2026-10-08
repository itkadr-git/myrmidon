// myrmidon(REVIEW-ROUTING): the attention signals of the review routing.
//
// Conditions raise a card on the operator desk, one per task/PR:
//
//   - `no_reviewer`: a task is in review with no reviewer and the routing
//     could not pick one (no eligible reviewer, or all are at their load
//     ceiling), so the review would otherwise stay silent; the PR lane raises
//     the same kind for a green PR head it could not route (carrying the PR
//     coordinates instead of a board task);
//   - `review_overdue`: a task has been in review longer than the configured
//     hours with no verdict (and, when the routing could not move it to
//     another reviewer, this card is what is left for a person to act on);
//   - `no_steward` (1.6.5 PR lane): an approved green PR head has no eligible
//     merge steward.
//
// The sweep REPLACES the whole set of a company on every pass
// (`replaceReviewRoutingSignals`): a card exists exactly while its condition
// held at the last pass, and disappears on the next pass after the task gets
// a reviewer, a verdict, or leaves review. The registry is process-level and
// recomputed within one pass after a restart; nothing is persisted (the same
// "computed on the fly" shape as the stale-block cards).

import type { AttentionSeverity } from "@paperclipai/shared";

export type ReviewRoutingSignalKind = "no_reviewer" | "review_overdue" | "no_steward";

/** The PR coordinates a PR-lane signal carries (1.6.5; board signals leave it absent). */
export interface ReviewRoutingSignalPr {
  repository: string;
  number: number;
  headSha: string | null;
}

export interface ReviewRoutingSignal {
  kind: ReviewRoutingSignalKind;
  issueId: string;
  companyId: string;
  identifier: string | null;
  title: string | null;
  /** ISO time the condition was first seen by this process. */
  since: string;
  /** Hours in review, for `review_overdue`. */
  hoursInReview: number | null;
  /** PR coordinates for the PR lane's signals (`no_reviewer`/`no_steward`). */
  pr?: ReviewRoutingSignalPr | null;
}

/**
 * Stable uuid-shaped synthetic subject id for a PR signal. The attention
 * enrichment joins subject ids against uuid columns, so a readable string id
 * breaks the feed query — the same trick the tracing-health card uses: a
 * deterministic, hex-safe derivation of the (repository, number), unique and
 * stable across passes.
 */
export function prSignalSubjectId(repository: string, number: number): string {
  const hex = `${repository}#${number}`
    .split("")
    .map((ch) => ch.charCodeAt(0).toString(16))
    .join("")
    .replace(/[^0-9a-f]/gi, "0")
    .padEnd(24, "0")
    .slice(0, 24);
  const body = `00000000${hex}`.padEnd(32, "0").slice(0, 32);
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}

const signalsByCompany = new Map<string, Map<string, ReviewRoutingSignal>>();

/** Registry key: a task may hold one card per kind; PR cards key on the synthetic subject. */
function signalKey(signal: ReviewRoutingSignal): string {
  return `${signal.kind}:${signal.issueId}`;
}

/**
 * Replaces the company's signals with `next`. A signal that already exists for
 * the same task and kind keeps its original `since`, so the card's timestamps
 * do not move on every pass.
 */
export function replaceReviewRoutingSignals(companyId: string, next: ReviewRoutingSignal[]): void {
  const previous = signalsByCompany.get(companyId);
  if (next.length === 0) {
    signalsByCompany.delete(companyId);
    return;
  }
  const byKey = new Map<string, ReviewRoutingSignal>();
  for (const signal of next) {
    const before = previous?.get(signalKey(signal));
    byKey.set(signalKey(signal), before ? { ...signal, since: before.since } : signal);
  }
  signalsByCompany.set(companyId, byKey);
}

export function readReviewRoutingSignals(companyId: string): ReviewRoutingSignal[] {
  return [...(signalsByCompany.get(companyId)?.values() ?? [])];
}

/** Test helper: forget every recorded signal. */
export function resetReviewRoutingSignals(): void {
  signalsByCompany.clear();
}

export function reviewRoutingSignalDedupKey(signal: ReviewRoutingSignal): string {
  if (signal.pr) {
    return `review_routing:${signal.kind}:pr:${signal.pr.repository}#${signal.pr.number}`;
  }
  return `review_routing:${signal.kind}:${signal.issueId}`;
}

export function reviewRoutingSignalTitle(signal: ReviewRoutingSignal): string {
  if (signal.pr) {
    return signal.kind === "no_steward"
      ? `An approved pull request has no merge steward (${signal.pr.repository}#${signal.pr.number})`
      : `A green pull request has no reviewer (${signal.pr.repository}#${signal.pr.number})`;
  }
  switch (signal.kind) {
    case "no_reviewer":
      return "A task in review has no reviewer";
    case "no_steward":
      return "An approved pull request has no merge steward";
    default:
      return "A review has had no verdict for too long";
  }
}

export function reviewRoutingSignalWhyNow(signal: ReviewRoutingSignal): string {
  if (signal.pr && signal.kind === "no_steward") {
    return `The pull request ${signal.pr.repository}#${signal.pr.number} is green and approved on its current head, but no merge steward could be assigned automatically (no invokable agent in the steward roles, or all are at their merge ceiling). Assign a steward or raise the ceiling.`;
  }
  if (signal.pr) {
    return `The pull request ${signal.pr.repository}#${signal.pr.number} is green without a review verdict on its current head, but no reviewer could be assigned automatically (none in the reviewer roles, or all are at their load ceilings). Assign a reviewer or add reviewer capacity.`;
  }
  if (signal.kind === "no_reviewer") {
    return "The task is in review and no reviewer could be assigned automatically: no eligible reviewer is available (none in the reviewer roles, or all are at their load ceiling). Assign a reviewer or add reviewer capacity.";
  }
  const hours = signal.hoursInReview === null ? "" : ` (${signal.hoursInReview} h)`;
  return `The task has been in review${hours} without a verdict, and it could not be handed to another reviewer. Decide the review or assign someone else.`;
}

export function reviewRoutingSignalSeverity(signal: ReviewRoutingSignal): AttentionSeverity {
  return signal.kind === "review_overdue" ? "medium" : "high";
}
