// server/src/myrmidon/review-history/query.ts
//
// myrmidon(1.8 LEARN): bounded, privacy-safe input for review-history learning.
// The 1.8 LEARN pipeline turns reviewer feedback into skill candidates, but a
// skill must never be distilled from stale or non-review text, and never from
// raw comment rows that carry author identities, run ids, metadata blobs, or
// credentials. This module is the narrow read/query boundary: callers hand in
// records they have already authorized and paginated; this file decides what is
// admissible, normalizes the timestamps, keeps only deterministic source
// references, and strips common credential/PII forms from the prose.
//
// Contract (OPE-12928):
// - returns the eligible review feedback entries only when EVERY supplied
//   record is admissible; `false` as soon as one record is older than the
//   30-day window, newer than `now`, not a review comment/decision, or missing
//   the fields the deterministic source reference needs;
// - the result carries an explicit allowlist (feedback, timestamp, issue,
//   PR coordinates, sourceRef). Author ids, user ids, run ids, and metadata
//   have no path across this boundary;
// - no skill files are produced here and no I/O happens: the distillation
//   caller owns pagination, authorization, and any later suggestion write.

/** The extraction window: 30 days, matching the LEARN contract. */
export const REVIEW_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The only comment kinds that count as review feedback. */
export type ReviewHistorySourceKind =
  | "review_comment"
  | "review_decision"
  | "issue_comment"
  | "system";

/** One candidate record, already loaded by the caller (no fetch inside). */
export interface ReviewHistorySource {
  /** Stable comment/decision id — the deterministic source reference's tail. */
  id: string;
  kind: ReviewHistorySourceKind;
  /** When the feedback happened, ISO-8601 — the 30-day filter reads this. */
  createdAt: string;
  /** The task the feedback belongs to (PR/issue reference, part 1). */
  issueId: string;
  /** Human-readable ticket key (e.g. `OPE-12928`). */
  issueIdentifier: string;
  /** PR coordinates (part 2 of the PR/issue reference). */
  pullRequest: { repository: string; number: number };
  /** The reviewer prose. */
  body: string;
}

/** One extracted, safe-to-use feedback entry. */
export interface ReviewFeedback {
  feedback: string;
  /** Normalized ISO-8601 timestamp of the original record. */
  timestamp: string;
  issue: { id: string; identifier: string };
  pullRequest: { repository: string; number: number };
  /**
   * Deterministic source reference: `issue:<id>:pr:<repo>#<n>:comment:<id>`.
   * Reproducible for the same record, no content, no author, no timestamp.
   */
  sourceRef: string;
}

/**
 * Extract review feedback for the learning pipeline.
 *
 * Returns `false` (not an empty array) when any input record is inadmissible:
 * silently dropping a stale or non-review record would let a caller believe
 * the whole history was inspected when it was not. Sorting is deterministic
 * (timestamp, then sourceRef) so repeated passes over the same history build
 * identical input.
 */
export function extractReviewFeedback(
  records: readonly ReviewHistorySource[],
  now: Date,
  windowMs: number = REVIEW_HISTORY_WINDOW_MS,
): ReviewFeedback[] | false {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return false;
  const until = now.getTime();
  const since = until - windowMs;
  const result: ReviewFeedback[] = [];

  for (const record of records) {
    // A non-review comment (ordinary discussion, system noise) disqualifies
    // the batch: the caller must filter its source first.
    if (record.kind !== "review_comment" && record.kind !== "review_decision") return false;

    // The 30-day boundary: outside either edge fails closed.
    const timestamp = Date.parse(record.createdAt);
    if (!Number.isFinite(timestamp) || timestamp < since || timestamp > until) return false;

    // Fields the deterministic source reference and the PR/issue link need.
    if (!record.id?.trim()) return false;
    if (!record.issueId?.trim()) return false;
    if (!record.issueIdentifier?.trim()) return false;
    if (!record.body?.trim()) return false;
    const pr = record.pullRequest;
    if (!pr?.repository?.trim()) return false;
    if (!Number.isSafeInteger(pr.number) || pr.number <= 0) return false;

    result.push({
      feedback: redactSensitiveText(record.body),
      timestamp: new Date(timestamp).toISOString(),
      issue: { id: record.issueId, identifier: record.issueIdentifier },
      pullRequest: { repository: pr.repository, number: pr.number },
      sourceRef: `issue:${record.issueId}:pr:${pr.repository}#${pr.number}:comment:${record.id}`,
    });
  }

  return result.sort(
    (a, b) => a.timestamp.localeCompare(b.timestamp) || a.sourceRef.localeCompare(b.sourceRef),
  );
}

/**
 * Strip common credential and PII forms from review prose. The allowlist
 * already excludes structured sensitive fields (author ids, run ids, metadata
 * never cross the boundary); this only guards the free text. Redactions are
 * replaced in place so the surrounding sentence (and its lesson) survives.
 * Order matters: multi-line key/certificate blocks first, then structured key
 * shapes, then labelled key/value forms, then emails.
 */
function redactSensitiveText(body: string): string {
  return body
    // PEM private-key and certificate blocks. A block without its END marker
    // (truncated paste) redacts to the end of the text: fail closed.
    .replace(
      /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)[ -]*-----(?:[\s\S]*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)[ -]*-----|[\s\S]*$)/gi,
      "[REDACTED]",
    )
    // OpenSSH/ECDSA public-key bodies: key type followed by a long base64 run.
    .replace(/\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]{80,}={0,2}(?=\s|$)/g, "[REDACTED]")
    // AWS access-key ids and OpenAI-style key prefixes.
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    // Labelled key/value forms, including headers like `Authorization: Bearer <val>`.
    .replace(
      /\b(?:authorization\s*:\s*bearer|api[ _-]?key|access[ _-]?key|client[ _-]?secret|authorization|bearer|token|password|secret)\s*[:=]?\s*\S+/gi,
      "[REDACTED]",
    )
    // Bare `Bearer <token>` without a colon (inline in prose).
    .replace(/\bBearer\s+[A-Za-z0-9\-_.=+/]{16,}/g, "[REDACTED]")
    // Emails.
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED]")
    .trim();
}
