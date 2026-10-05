// myrmidon(REVIEW-ROUTING): the attention signals of the review routing.
//
// Two conditions raise a card on the operator desk, one per task:
//
//   - `no_reviewer`: a task is in review with no reviewer and the routing
//     could not pick one (no eligible reviewer, or all are at their load
//     ceiling), so the review would otherwise stay silent;
//   - `review_overdue`: a task has been in review longer than the configured
//     hours with no verdict (and, when the routing could not move it to
//     another reviewer, this card is what is left for a person to act on).
//
// The sweep REPLACES the whole set of a company on every pass
// (`replaceReviewRoutingSignals`): a card exists exactly while its condition
// held at the last pass, and disappears on the next pass after the task gets
// a reviewer, a verdict, or leaves review. The registry is process-level and
// recomputed within one pass after a restart; nothing is persisted (the same
// "computed on the fly" shape as the stale-block cards).

import type { AttentionSeverity } from "@paperclipai/shared";

export type ReviewRoutingSignalKind = "no_reviewer" | "review_overdue";

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
}

const signalsByCompany = new Map<string, Map<string, ReviewRoutingSignal>>();

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
  const byIssue = new Map<string, ReviewRoutingSignal>();
  for (const signal of next) {
    const before = previous?.get(signal.issueId);
    byIssue.set(signal.issueId, before && before.kind === signal.kind ? { ...signal, since: before.since } : signal);
  }
  signalsByCompany.set(companyId, byIssue);
}

export function readReviewRoutingSignals(companyId: string): ReviewRoutingSignal[] {
  return [...(signalsByCompany.get(companyId)?.values() ?? [])];
}

/** Test helper: forget every recorded signal. */
export function resetReviewRoutingSignals(): void {
  signalsByCompany.clear();
}

export function reviewRoutingSignalDedupKey(signal: ReviewRoutingSignal): string {
  return `review_routing:${signal.kind}:${signal.issueId}`;
}

export function reviewRoutingSignalTitle(signal: ReviewRoutingSignal): string {
  return signal.kind === "no_reviewer"
    ? "A task in review has no reviewer"
    : "A review has had no verdict for too long";
}

export function reviewRoutingSignalWhyNow(signal: ReviewRoutingSignal): string {
  if (signal.kind === "no_reviewer") {
    return "The task is in review and no reviewer could be assigned automatically: no eligible reviewer is available (none in the reviewer roles, or all are at their load ceiling). Assign a reviewer or add reviewer capacity.";
  }
  const hours = signal.hoursInReview === null ? "" : ` (${signal.hoursInReview} h)`;
  return `The task has been in review${hours} without a verdict, and it could not be handed to another reviewer. Decide the review or assign someone else.`;
}

export function reviewRoutingSignalSeverity(signal: ReviewRoutingSignal): AttentionSeverity {
  return signal.kind === "no_reviewer" ? "high" : "medium";
}
