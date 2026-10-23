// Fork features with live health (myrmidon FEATURES):
// GET /api/myrmidon/features and PATCH /api/myrmidon/features/:key.
//
// GET returns every feature of the fork registry with its effective config
// (value and where it came from), its settings panel and its health. PATCH
// flips the inline switch of a feature that has one (instance admins only).
import { api } from "@/api/client";
import type { FeaturesReport, FeatureView } from "@paperclipai/shared";

export const featuresQueryKey = ["myrmidon", "features"] as const;

export const featuresApi = {
  get: (fresh = false) => api.get<FeaturesReport>(`/myrmidon/features${fresh ? "?fresh=1" : ""}`),
  setEnabled: (key: string, enabled: boolean) =>
    api.patch<FeatureView>(`/myrmidon/features/${encodeURIComponent(key)}`, { enabled }),
};

export type { FeaturesReport, FeatureView };
