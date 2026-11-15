// server/src/myrmidon/review-history/index.ts
//
// myrmidon(1.8 LEARN): the module's public surface — the bounded read/query
// boundary (query.ts, OPE-12928) plus the pattern-grouping stage that turns
// repeated sanitized findings into gated draft skill proposals (patterns.ts,
// OPE-12939). No routes, no sweep, no skill-file writes: skill generation
// consumes these contracts; the extraction, grouping, and any later
// suggestion write stay explicit at the call site.

export {
  REVIEW_HISTORY_WINDOW_MS,
  extractReviewFeedback,
} from "./query.js";
export {
  REVIEW_PATTERN_MIN_OCCURRENCES,
  REDACTION_MARKER,
  groupReviewPatterns,
  proposeDraftSkills,
} from "./patterns.js";
export type {
  ReviewFeedback,
  ReviewHistorySource,
  ReviewHistorySourceKind,
} from "./query.js";
export type {
  DraftSkillProposal,
  PatternFinding,
  ReviewPattern,
} from "./patterns.js";
