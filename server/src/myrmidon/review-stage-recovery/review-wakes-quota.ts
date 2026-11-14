// myrmidon(OPE-12178): the per-tick quota of new reviewer wakes.
//
// The green-CI admission gate (OPE-12176) already decides whether a reviewer
// may be woken at all. This quota is the second, flow-shaped half of that
// gate: even an admitted (green, non-critical) wake must not all fire in the
// same tick, so a wave of review hand-offs cannot stampede every reviewer in
// the company at once. The shape mirrors the precedent of the review-routing
// sweep (`REVIEW_ROUTING_MAX_WAKES_PER_PASS = 1`, `MAX_MOVES_PER_PASS = 20`).
//
// A wake the tick's quota cannot admit is deferred without loss: the caller
// arms the same bounded "Review CI wait" monitor the green-CI gate already
// uses (OPE-12176), whose next tick wakes the reviewer as an
// `execution_review_participant_recovery` once the quota has room again.
// Critical issues keep the old behaviour — they review in parallel with CI
// and never spend this quota (analogous to REVIEW_ROUTING critical bypass).

/** New reviewer wakes a non-critical review admission may create in one tick. */
export const REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK = 1;

/**
 * Budget carrier of one tick. The tick clears one per company
 * (`clearReviewWakesQuotas(now)` at the top of `tickTimers`); the two review
 * admission sites (`server/src/routes/issues.ts`) spend from it only after the
 * green-CI gate already said "admit" and only for a non-critical issue.
 */
export interface ReviewWakesQuota {
  remaining: number;
  /**
   * Admission keys already admitted in this tick. One reviewer handoff is
   * checked against the quota twice (the transactional receipt site and the
   * post-update wake site in `routes/issues.ts` build the same
   * `issue-review-admission:{issueId}:{agentId}` key); the key makes the
   * second check of the SAME admission free instead of a second spend, so
   * one handoff costs exactly one slot.
   */
  admittedKeys?: Set<string>;
  /**
   * Issues whose review already holds a slot in this tick. A later admission
   * of the SAME issue (a moved PR head builds a fresh head-keyed key,
   * OPE-12177) is a re-wake of a review already under way, not a new review,
   * so it is admitted free instead of being deferred by the spent budget.
   */
  admittedIssueIds?: Set<string>;
}

/**
 * Prefix of the review-admission idempotency key. Mirrors
 * `REVIEW_ADMISSION_KEY_PREFIX` of `policy.ts` (not imported: `policy.ts`
 * imports this module). Key shapes (`reviewAdmissionDedupKey`):
 * `issue-review-admission:{issueId}:{headSha}` or, without a head SHA,
 * `issue-review-admission:{issueId}:{agentId}`.
 */
const REVIEW_ADMISSION_KEY_PREFIX = "issue-review-admission:";

/** The issue id of a review-admission key, or null for a foreign/empty key. */
function admissionKeyIssueId(admissionKey: string | undefined): string | null {
  if (!admissionKey || !admissionKey.startsWith(REVIEW_ADMISSION_KEY_PREFIX)) return null;
  const issueId = admissionKey.slice(REVIEW_ADMISSION_KEY_PREFIX.length).split(":", 1)[0];
  return issueId ? issueId : null;
}

/**
 * State of one admission decision under the quota. `quota_reached` mirrors
 * the gate's deferral vocabulary: the reviewer is not woken now, the caller
 * arms the retry monitor, nothing is lost.
 */
export type ReviewWakesQuotaDecision = "admit" | "quota_reached";

/**
 * May one more new reviewer wake be created in this tick?
 *
 * A critical issue is always admitted and never spends the quota — the same
 * bypass rule the green-CI gate applies. `remaining` is capped at 0, so a
 * passive read never turns the counter negative.
 */
export function admitReviewerUnderWakesQuota(
  quota: ReviewWakesQuota | null | undefined,
  critical: boolean,
  admissionKey?: string,
): ReviewWakesQuotaDecision {
  if (critical) return "admit";
  // The same admission (same issue + reviewer) is evaluated at both admission
  // sites of one handoff; the second evaluation must observe the first one's
  // decision instead of spending a second slot.
  if (admissionKey && quota?.admittedKeys?.has(admissionKey)) return "admit";
  // Same issue, new key (the PR head moved): the review is already running
  // under a slot spent earlier in this tick — admit without a second spend.
  const issueId = admissionKeyIssueId(admissionKey);
  if (issueId && quota?.admittedIssueIds?.has(issueId)) {
    (quota.admittedKeys ??= new Set()).add(admissionKey!);
    return "admit";
  }
  const remaining = Math.max(0, Math.floor(quota?.remaining ?? 0));
  if (remaining < 1) return "quota_reached";
  quota!.remaining = remaining - 1;
  if (admissionKey) {
    (quota!.admittedKeys ??= new Set()).add(admissionKey);
  }
  if (issueId) {
    (quota!.admittedIssueIds ??= new Set()).add(issueId);
  }
  return "admit";
}

/** A fresh budget for one tick: `REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK` wakes per company. */
export function freshReviewWakesQuota(): ReviewWakesQuota {
  return { remaining: REVIEW_GATE_MAX_NEW_REVIEW_WAKES_PER_TICK, admittedKeys: new Set(), admittedIssueIds: new Set() };
}

/** Clears every company's budget for the new tick (missing entries start fresh on demand). */
export function clearReviewWakesQuotas(now: Date): void {
  reviewWakesQuotaByCompany.clear();
  reviewWakesQuotaTickStartedAt = now;
}

let reviewWakesQuotaTickStartedAt: Date | null = null;

const reviewWakesQuotaByCompany = new Map<string, ReviewWakesQuota>();

/** The quota bucket of one company; a company with no bucket yet starts with a fresh budget. */
export function reviewWakesQuotaForCompany(companyId: string): ReviewWakesQuota {
  let quota = reviewWakesQuotaByCompany.get(companyId);
  if (!quota) {
    quota = freshReviewWakesQuota();
    reviewWakesQuotaByCompany.set(companyId, quota);
  }
  return quota;
}

/** Test/diagnostic helper: which tick the current buckets were cleared for. */
export function reviewWakesQuotaTickStarted(): Date | null {
  return reviewWakesQuotaTickStartedAt;
}
