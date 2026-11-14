// ui/src/components/myrmidon/model-providers/modelGroupRulesApi.ts
//
// myrmidon(1.8 MODEL-BY-STEP, OPE-12997): HTTP client for the company
// model-group rules settings screen.

import { api } from "@/api/client";
import type {
  CompanyModelGroupRulesView,
  SaveCompanyModelGroupRulesInput,
} from "@myrmidon/shared";

export const modelGroupRulesQueryKey = (companyId: string) => [
  "myrmidon",
  "model-group-rules",
  companyId,
] as const;

export const modelGroupRulesApi = {
  get(companyId: string): Promise<CompanyModelGroupRulesView> {
    return api.get(`/myrmidon/companies/${companyId}/model-group-rules`);
  },
  save(
    companyId: string,
    input: SaveCompanyModelGroupRulesInput,
  ): Promise<CompanyModelGroupRulesView> {
    return api.put(`/myrmidon/companies/${companyId}/model-group-rules`, input);
  },
};
