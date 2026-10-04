// myrmidon(REVIEW-ROUTING): API client for the automatic reviewer routing settings.
//
//   GET /api/myrmidon/companies/:companyId/review-routing/settings
//   PUT /api/myrmidon/companies/:companyId/review-routing/settings (same body)
import { api } from "@/api/client";

export interface ReviewRoutingSettings {
  enabled: boolean;
  /** Caste keys (`agents.role`) whose agents may be picked as reviewers. */
  reviewerRoles: string[];
  /** A reviewer already holding this many tasks in flight is not picked. */
  maxLoadPerReviewer: number;
  /** Hours without a verdict before the review is reassigned; 0 — never. */
  reassignAfterHours: number;
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
