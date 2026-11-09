// myrmidon(OPE-12181, REVIEW-CHECKS-NATIVE A): the structured form of a board
// review verdict. A formal review decision on a ticket used to live only in the
// decision comment text (`APPROVE PR #N <sha>`), and every consumer re-parsed
// that text with regexes. The decision is now also recorded as structure next to
// the decision id — `executionState.reviewDecision` — and consumers read the
// structure when it is present, falling back to text parsing only for tickets
// that were decided before the record existed.
//
// No database and no network here: the record is extracted once at decision
// time (routes) and stored in `issues.execution_state` JSON, so no migration.

import { declaredReviewedHead } from "../review-routing/pr-policy.js";

/** The two formal verdicts a review stage can produce. */
export type ReviewVerdictDecision = "approved" | "changes_requested";

/** The structured form of one review verdict, stored on the issue. */
export interface ReviewVerdictRecord {
  reviewDecision: ReviewVerdictDecision;
  /** Head commit sha the verdict names, when the text (or CI resolver) has one. */
  headSha: string | null;
  /** Pull request number the verdict names, when the text has one. */
  pullRequestNumber: number | null;
}

/** Execution-state key the record is stored under. */
export const REVIEW_VERDICT_STATE_KEY = "reviewDecision";

const PR_NUMBER_PATTERN = /(?:^|[^A-Za-z0-9_.-])PR\s*#([1-9][0-9]*)\b/i;
const LOOSE_PR_NUMBER_PATTERN = /(?:^|[^A-Za-z0-9_.-])#([1-9][0-9]*)\b/;

function normalizeDecision(outcome: string | null | undefined): ReviewVerdictDecision | null {
  const value = outcome?.trim().toLowerCase();
  if (value === "approved" || value === "approve") return "approved";
  if (value === "changes_requested" || value === "request_changes") return "changes_requested";
  return null;
}

function normalizeHeadSha(headSha: string | null | undefined): string | null {
  const value = headSha?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{7,40}$/.test(value) ? value : null;
}

function parsePullRequestNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const explicit = PR_NUMBER_PATTERN.exec(text);
  if (explicit?.[1]) return parseInt(explicit[1], 10);
  const loose = LOOSE_PR_NUMBER_PATTERN.exec(text);
  if (loose?.[1]) return parseInt(loose[1], 10);
  return null;
}

/**
 * Extracts the record from a decision at write time. This is the single point
 * where the verdict text is parsed; downstream consumers read the stored
 * structure instead of regexing the comment again.
 *
 * Returns null when the outcome is not a formal review verdict — nothing is
 * recorded and consumers keep their fallback behaviour.
 */
export function extractReviewVerdictRecord(input: {
  outcome: string | null | undefined;
  body: string | null | undefined;
  headSha?: string | null;
}): ReviewVerdictRecord | null {
  const reviewDecision = normalizeDecision(input.outcome);
  if (!reviewDecision) return null;
  const headSha = normalizeHeadSha(input.headSha) ?? declaredReviewedHead(input.body ?? null);
  return {
    reviewDecision,
    headSha,
    pullRequestNumber: parsePullRequestNumber(input.body ?? null),
  };
}

/**
 * Reads the stored record from an execution state. Returns null when the state
 * predates the record or carries no structure — the consumer then falls back to
 * parsing the decision text.
 */
export function readReviewVerdictRecord(state: unknown): ReviewVerdictRecord | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const value = (state as Record<string, unknown>)[REVIEW_VERDICT_STATE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const reviewDecision = normalizeDecision(
    typeof record.reviewDecision === "string" ? record.reviewDecision : null,
  );
  if (!reviewDecision) return null;
  const headSha = typeof record.headSha === "string" ? normalizeHeadSha(record.headSha) : null;
  const pullRequestNumber =
    typeof record.pullRequestNumber === "number" && Number.isInteger(record.pullRequestNumber) && record.pullRequestNumber > 0
      ? record.pullRequestNumber
      : null;
  return { reviewDecision, headSha, pullRequestNumber };
}

/** Writes the record into an execution-state object (immutably). */
export function withReviewVerdictRecord<T extends object>(
  state: T,
  record: ReviewVerdictRecord | null,
): T {
  const next: Record<string, unknown> = { ...(state as unknown as Record<string, unknown>) };
  delete next[REVIEW_VERDICT_STATE_KEY];
  if (record) next[REVIEW_VERDICT_STATE_KEY] = record;
  return next as unknown as T;
}
