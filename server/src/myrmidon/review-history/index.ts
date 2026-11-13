// server/src/myrmidon/review-history/index.ts
//
// myrmidon(1.8 LEARN): the module's public surface — the bounded read/query
// boundary only. No routes, no sweep, no skill-file writes: 1.8 LEARN's skill
// generation flow consumes this contract; the extraction itself stays
// explicit at the call site.

export {
  REVIEW_HISTORY_WINDOW_MS,
  extractReviewFeedback,
} from "./query.js";
export type {
  ReviewFeedback,
  ReviewHistorySource,
  ReviewHistorySourceKind,
} from "./query.js";
