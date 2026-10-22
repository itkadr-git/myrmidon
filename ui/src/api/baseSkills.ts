// myrmidon(1.6.5 BASE-SKILLS): the company base-skills registry API client.
import type {
  CompanyBaseSkillAddRequest,
  CompanyBaseSkillMutationResponse,
  CompanyBaseSkillOverview,
  CompanyBaseSkillRemoveResponse,
} from "@paperclipai/shared";
import { api } from "./client";

function baseSkillsPath(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/base-skills`;
}

export const baseSkillsApi = {
  overview: (companyId: string) => api.get<CompanyBaseSkillOverview>(baseSkillsPath(companyId)),
  add: (companyId: string, keys: CompanyBaseSkillAddRequest["keys"]) =>
    api.post<CompanyBaseSkillMutationResponse>(baseSkillsPath(companyId), { keys }),
  remove: (companyId: string, key: string) =>
    api.delete<CompanyBaseSkillRemoveResponse>(`${baseSkillsPath(companyId)}/${encodeURIComponent(key)}`),
  apply: (companyId: string) =>
    api.post<CompanyBaseSkillMutationResponse>(`${baseSkillsPath(companyId)}/apply`, {}),
};