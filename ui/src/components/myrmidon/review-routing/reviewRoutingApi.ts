// myrmidon(REVIEW-ROUTING): API client for the automatic reviewer routing settings.
//
//   GET /api/myrmidon/companies/:companyId/review-routing/settings
//   PUT /api/myrmidon/companies/:companyId/review-routing/settings (same body)
//
// myrmidon(REVIEW-ROUTING PR-events UI): the `prWatch` block below is a LOCAL
// mirror of the shape part A (server) adds to
// `packages/shared/src/myrmidon-review-routing.ts`. The PUT is full-object, so
// the client must know the block to preserve it. Once part A merges, replace
// this interface with an import from `@paperclipai/shared`.
import { api } from "@/api/client";

/**
 * Pull-request lane settings (`prWatch`): the board watches green pull requests
 * and raises review tasks from events instead of standing split tasks, and an
 * optional merge steward pushes accepted reviews over the finish line.
 */
export interface ReviewRoutingPrStewardSettings {
  /** Steward pass enabled. */
  enabled: boolean;
  /** Caste keys (`agents.role`) whose agents may act as the merge steward. */
  roles: string[];
  /** Merges one steward performs per pass (1..50). */
  maxMergesPerSteward: number;
}

export interface ReviewRoutingPrWatchSettings {
  /** Create review tasks from pull-request events. */
  enabled: boolean;
  /** `"owner/repo"` entries to watch; empty — every repository the board sees. */
  repositories: string[];
  /** Open reviews one reviewer may hold at once (1..100). */
  maxOpenReviewsPerReviewer: number;
  /** Review tasks one polling pass assigns at most (1..50). */
  maxNewAssignmentsPerPass: number;
  /** Polling period in seconds (15..3600). */
  pollIntervalSec: number;
  /** The merge steward sub-block. */
  steward: ReviewRoutingPrStewardSettings;
}

export interface ReviewRoutingSettings {
  enabled: boolean;
  /** Caste keys (`agents.role`) whose agents may be picked as reviewers. */
  reviewerRoles: string[];
  /** A reviewer already holding this many tasks in flight is not picked. */
  maxLoadPerReviewer: number;
  /** Hours without a verdict before the review is reassigned; 0 — never. */
  reassignAfterHours: number;
  /**
   * Pull-request lane. Optional in the wire shape until part A (PR 705) merges:
   * an older server omits it, and because the PUT schema is `.strict()` the
   * screen then hides the section and never sends the key back.
   */
  prWatch?: ReviewRoutingPrWatchSettings;
}

export const reviewRoutingSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "review-routing", "settings", companyId] as const;

const settingsPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/review-routing/settings`;

export const reviewRoutingApi = {
  getSettings: (companyId: string) => api.get<ReviewRoutingSettings>(settingsPath(companyId)),
  putSettings: (companyId: string, settings: ReviewRoutingSettings) =>
    api.put<ReviewRoutingSettings>(settingsPath(companyId), settings),
};
