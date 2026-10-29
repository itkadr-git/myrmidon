// ui/src/components/myrmidon/hindsight-models/hindsightModelsApi.ts
//
// OPE-9858: API client for Hindsight model groups.
// Connects to /api/myrmidon/hindsight/model-groups and /api/myrmidon/companies/:companyId/hindsight/model-groups.

import type {
  HindsightModelCatalogView,
  PatchHindsightModels,
} from "@myrmidon/shared";
import { api } from "@/api/client";

export const hindsightModelGroupsQueryKey = ["myrmidon", "hindsight", "model-groups"] as const;

export const hindsightModelsApi = {
  getCatalog: (companyId?: string) => {
    const url = companyId
      ? `/myrmidon/companies/${companyId}/hindsight/model-groups`
      : `/myrmidon/hindsight/model-groups`;
    return api.get<HindsightModelCatalogView>(url);
  },
  updateCatalog: (patch: PatchHindsightModels, companyId?: string) => {
    const url = companyId
      ? `/myrmidon/companies/${companyId}/hindsight/model-groups`
      : `/myrmidon/hindsight/model-groups`;
    return api.patch<HindsightModelCatalogView>(url, patch);
  },
};
