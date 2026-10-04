// Shared GitHub authorization access rules (myrmidon GITHUB-SHARED-IDENTITY):
// GET/PUT /api/myrmidon/companies/:companyId/github-shared-identity.
//
// The shared authorization itself is an ordinary managed GitHub connection
// with the "Shared company GitHub account" identity (one OAuth pass, under
// Apps → GitHub). These rules say, per shared connection, which agents may
// use it and for which repositories. Saving applies to the next git/gh
// operation — no restart. No token ever travels through this API.
import { api } from "@/api/client";

export interface GitHubSharedConnectionRule {
  connectionId: string;
  roles: string[];
  agentIds: string[];
  allowedRepos: string[];
}

export interface GitHubSharedIdentitySettings {
  version: 1;
  enabled: boolean;
  connections: GitHubSharedConnectionRule[];
  commitEmailDomain: string | null;
}

export interface SharedGitHubConnectionView {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  installedForCompany: boolean;
  grant: {
    status: string;
    login: string | null;
    repositoryCount: number | null;
    repositorySelection: string | null;
  } | null;
}

export interface GitHubSharedIdentityView {
  settings: GitHubSharedIdentitySettings;
  connections: SharedGitHubConnectionView[];
}

export type GitHubSharedIdentityPut = Omit<GitHubSharedIdentitySettings, "version">;

export const githubSharedIdentityQueryKey = (companyId: string) =>
  ["myrmidon", "github-shared-identity", companyId] as const;

export const githubSharedIdentityApi = {
  get: (companyId: string) =>
    api.get<GitHubSharedIdentityView>(`/myrmidon/companies/${companyId}/github-shared-identity`),
  save: (companyId: string, body: GitHubSharedIdentityPut) =>
    api.put<GitHubSharedIdentityView>(`/myrmidon/companies/${companyId}/github-shared-identity`, body),
};

/** One entry per line or comma; blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
