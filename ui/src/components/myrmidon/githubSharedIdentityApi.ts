// Self-hosted GitHub App identities (myrmidon GITHUB-SHARED-IDENTITY):
// GET/PUT /api/myrmidon/companies/:companyId/github-shared-identity.
//
// "Authorize once for the whole server": the operator registers our own
// GitHub App per account or organization, stores its private key as a
// company secret, and lists here which agents may use it for which
// repositories. The board mints short-lived single-repository installation
// tokens itself. Saving applies to the next git/gh operation — no restart.
// No key or token ever travels through this API.
import { api } from "@/api/client";

export interface GitHubAppEntry {
  id: string;
  name: string;
  appId: string;
  privateKeySecretId: string;
  installationId: string | null;
  roles: string[];
  agentIds: string[];
  allowedRepos: string[];
  /** GitHub App slug for Apps created through the manifest flow (myrmidon GITHUB-APP-MANIFEST). */
  slug?: string | null;
}

// myrmidon(GITHUB-APP-MANIFEST): one-click GitHub App creation — the server
// builds the manifest, the browser POSTs it to github.com (manifest flow),
// GitHub redirects back to the server callback, which lands on the company
// settings page with ?github_app_created=1 or ?github_app_error=<message>.
export interface BeginAppManifestBody {
  ownerKind: "user" | "org";
  orgLogin?: string;
  name: string;
  description?: string;
}

export interface BeginAppManifestResponse {
  manifestUrl: string;
  manifest: Record<string, unknown>;
}

export interface AppInstallUrlResponse {
  installUrl: string;
}

export interface GitHubSharedIdentitySettings {
  version: 1;
  enabled: boolean;
  apps: GitHubAppEntry[];
  commitEmailDomain: string | null;
}

export interface GitHubSharedIdentityView {
  settings: GitHubSharedIdentitySettings;
  /** Whether the vendor cloud GitHub connector is enabled on this instance (off by default). */
  vendorConnectorEnabled: boolean;
}

export type GitHubSharedIdentityPut = Omit<GitHubSharedIdentitySettings, "version">;

export const githubSharedIdentityQueryKey = (companyId: string) =>
  ["myrmidon", "github-shared-identity", companyId] as const;

export const githubSharedIdentityApi = {
  get: (companyId: string) =>
    api.get<GitHubSharedIdentityView>(`/myrmidon/companies/${companyId}/github-shared-identity`),
  save: (companyId: string, body: GitHubSharedIdentityPut) =>
    api.put<GitHubSharedIdentityView>(`/myrmidon/companies/${companyId}/github-shared-identity`, body),
  beginAppManifest: (companyId: string, body: BeginAppManifestBody) =>
    api.post<BeginAppManifestResponse>(
      `/myrmidon/companies/${companyId}/github-shared-identity/app-manifest/begin`,
      body,
    ),
  getAppInstallUrl: (companyId: string, entryId: string) =>
    api.get<AppInstallUrlResponse>(
      `/myrmidon/companies/${companyId}/github-shared-identity/apps/${entryId}/install`,
    ),
};

/** One entry per line or comma; blanks dropped. */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
