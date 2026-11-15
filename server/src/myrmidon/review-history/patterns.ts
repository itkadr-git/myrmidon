// server/src/myrmidon/review-history/patterns.ts
//
// myrmidon(1.8 LEARN, OPE-12939): the pattern-grouping stage of the
// learn-from-code-review flow. It sits after the safe 30-day extraction
// (query.ts, OPE-12928): `extractReviewFeedback` decides which review prose is
// admissible; this module decides when that prose repeats often enough to
// deserve a skill, shapes the draft proposal, and keeps the human gate closed.
//
// Contract (OPE-12939):
// - group sanitized findings into patterns by a normalized key; only a pattern
//   seen at least `minOccurrences` times becomes a draft proposal;
// - a draft proposal carries the sanitized lesson text and the deterministic
//   source refs of every contributing finding (provenance is never dropped:
//   an empty provenance yields no draft, and false fails closed);
// - every draft is born `pending` (`approvalState: "pending"`). Nothing in
//   this module flips it to approved, enabled, or delivered — publishing a
//   skill stays behind the existing `skill_promotion` approval gate in
//   skill-lifecycle/domain.ts (assertPromotionApproval);
// - one-off findings, noisy/low-signal findings, and findings that still carry
//   sensitive forms yield NO draft. Anything ambiguous fails closed (`false`);
// - no I/O, no routes, no persistence: the caller owns storage, the approval
//   record, and any later skill write.

/** A draft skill proposal cannot exist below this repetition count. */
export const REVIEW_PATTERN_MIN_OCCURRENCES = 2;

/**
 * Redaction marker shared with query.ts. A finding that still contains it was
 * not fully sanitized upstream — it must never reach a draft.
 */
export const REDACTION_MARKER = "[REDACTED]";

/**
 * Normalization for pattern keys: lowercase, collapse whitespace, strip
 * punctuation that varies by phrasing, drop common filler words that carry no
 * review signal. Two findings land in one bucket only when their remaining
 * word sequence is identical — grouping must stay conservative, because a
 * false merge writes a wrong lesson into a skill.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "this", "that", "please",
]);

/**
 * A sanitized, admissible finding — structurally identical to the
 * `ReviewFeedback` produced by `extractReviewFeedback` (OPE-12928). Declared
 * structurally so this stage stays decoupled from the extraction module's
 * import graph and works with any upstream that honors the same shape.
 */
export interface PatternFinding {
  feedback: string;
  timestamp: string;
  issue: { id: string; identifier: string };
  pullRequest: { repository: string; number: number };
  /** Deterministic source reference, e.g. `issue:<id>:pr:<repo>#<n>:comment:<id>`. */
  sourceRef: string;
}

/** One repeated review pattern, grouped from sanitized findings. */
export interface ReviewPattern {
  /** Normalized key the findings were grouped by. */
  key: string;
  /** Sanitized prose, shared by every finding in the group. */
  text: string;
  findings: PatternFinding[];
}

/**
 * A draft skill proposal. Born `pending`; only a human approval of type
 * `skill_promotion` (outside this module) may ever move it forward.
 */
export interface DraftSkillProposal {
  slug: string;
  title: string;
  /** The distilled lesson text a skill would carry once approved. */
  body: string;
  approvalState: "pending";
  /** Deterministic provenance: every contributing finding's sourceRef. */
  sources: Array<{
    sourceRef: string;
    issue: { id: string; identifier: string };
    pullRequest: { repository: string; number: number };
    timestamp: string;
  }>;
  occurrenceCount: number;
  createdAt: string;
}

/**
 * Group sanitized findings into patterns.
 *
 * Returns `false` when the input is unusable (empty, non-array, or any entry
 * missing the provenance fields) — failing closed instead of silently
 * grouping a partial history. Findings with identical normalized keys merge;
 * each group keeps every member's sourceRef, so provenance survives grouping.
 */
export function groupReviewPatterns(
  findings: readonly PatternFinding[],
): ReviewPattern[] | false {
  if (!Array.isArray(findings)) return false;

  const groups = new Map<string, ReviewPattern>();

  for (const finding of findings) {
    if (!finding || typeof finding !== "object") return false;
    if (!finding.feedback?.trim()) return false;
    if (!finding.sourceRef?.trim()) return false;
    if (!finding.issue?.id?.trim() || !finding.issue?.identifier?.trim()) return false;
    if (!finding.pullRequest?.repository?.trim()) return false;
    if (!Number.isSafeInteger(finding.pullRequest.number) || finding.pullRequest.number <= 0) return false;
    if (!Number.isFinite(Date.parse(finding.timestamp))) return false;

    const key = patternKey(finding.feedback);
    // A finding whose text normalizes away entirely (pure noise) never
    // contributes to a pattern.
    if (!key) continue;

    const existing = groups.get(key);
    if (existing) {
      existing.findings.push(finding);
    } else {
      groups.set(key, {
        key,
        text: finding.feedback.trim(),
        findings: [finding],
      });
    }
  }

  return [...groups.values()];
}

/**
 * Turn repeated patterns into draft skill proposals — the output a human
 * gate reviews. Never publishes: every proposal is `pending`, carries full
 * provenance, and nothing here writes a skill file.
 *
 * Returns `false` when grouping fails closed (see `groupReviewPatterns`) or
 * when any surviving finding still carries the redaction marker (it was not
 * fully sanitized upstream). Patterns below `minOccurrences` (default 2) and
 * findings whose provenance is missing yield no draft — silently promoting a
 * one-off or unattributed remark into a proposal would be the failure this
 * gate exists to prevent.
 */
export function proposeDraftSkills(
  findings: readonly PatternFinding[],
  options: {
    now?: Date;
    minOccurrences?: number;
  } = {},
): DraftSkillProposal[] | false {
  const now = options.now ?? new Date();
  const minOccurrences = options.minOccurrences ?? REVIEW_PATTERN_MIN_OCCURRENCES;
  if (!Number.isSafeInteger(minOccurrences) || minOccurrences < 1) return false;
  if (!Number.isFinite(now.getTime())) return false;

  // A finding that still shows the redaction marker was not sanitized
  // upstream; a draft from it could carry a credential or PII shape.
  for (const finding of findings) {
    if (finding.feedback.includes(REDACTION_MARKER)) return false;
  }

  const groups = groupReviewPatterns(findings);
  if (groups === false) return false;

  const proposals: DraftSkillProposal[] = [];

  for (const group of groups) {
    if (group.findings.length < minOccurrences) continue;

    const sources = group.findings.map((finding) => ({
      sourceRef: finding.sourceRef,
      issue: { id: finding.issue.id, identifier: finding.issue.identifier },
      pullRequest: { repository: finding.pullRequest.repository, number: finding.pullRequest.number },
      timestamp: finding.timestamp,
    }));
    if (sources.length === 0) continue;

    const title = titleFromPattern(group);
    proposals.push({
      slug: slugify(`${group.key.slice(0, 48)}-${group.findings.length}-x`),
      title,
      body: group.text,
      approvalState: "pending",
      sources,
      occurrenceCount: group.findings.length,
      createdAt: now.toISOString(),
    });
  }

  return proposals.sort(
    (a, b) =>
      b.occurrenceCount - a.occurrenceCount ||
      a.slug.localeCompare(b.slug),
  );
}

/**
 * Normalized pattern key for prose: lowercase, collapsed whitespace, word
 * sequence minus punctuation and filler. Returns "" for pure noise.
 */
function patternKey(feedback: string): string {
  const words = feedback
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
  if (words.length === 0) return "";
  return words.join(" ");
}

function titleFromPattern(group: ReviewPattern): string {
  const words = group.key.split(" ");
  const headline = words.slice(0, 8).join(" ");
  const capitalized = headline.charAt(0).toUpperCase() + headline.slice(1);
  return `Review pattern: ${capitalized}`;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "review-pattern"
  );
}
