// Self-hosted GitHub App identities (myrmidon GITHUB-SHARED-IDENTITY):
// GET/PUT /api/myrmidon/companies/:companyId/github-shared-identity.
//
// "Authorize once for the whole server": the operator registers our own
// GitHub App per account or organization, stores its private key as a
// company secret, and lists here which agents may use it for which
// repositories, with which permissions (the broker requests exactly that
// list; default: contents and pull requests write). The board mints
// short-lived single-repository installation tokens itself. Saving applies
// to the next git/gh operation — no restart. No key or token ever travels
// through this API.
import { api } from "@/api/client";

/** The permission keys the board lets an entry request (allow-list; secrets/administration are not offered). */
export const GITHUB_APP_PERMISSION_KEYS = [
  "actions",
  "checks",
  "contents",
  "deployments",
  "environments",
  "issues",
  "pull_requests",
  "workflows",
] as const;

export type GitHubAppPermissionKey = (typeof GITHUB_APP_PERMISSION_KEYS)[number];
export type GitHubAppPermissionLevel = "none" | "read" | "write";
/** Complete stored permission list of one App entry. */
export type GitHubAppPermissions = Record<GitHubAppPermissionKey, GitHubAppPermissionLevel>;

/** The historical fixed set (contents + pull requests write) — the default per entry. */
export const DEFAULT_GITHUB_APP_PERMISSIONS: GitHubAppPermissions = {
  actions: "none",
  checks: "none",
  contents: "write",
  deployments: "none",
  environments: "none",
  issues: "none",
  pull_requests: "write",
  workflows: "none",
};

/** GitHub's token API accepts only `write` for workflows (and only `read`/`write` per key in general). */
export function githubAppPermissionLevelsFor(key: GitHubAppPermissionKey): GitHubAppPermissionLevel[] {
  return key === "workflows" ? ["none", "write"] : ["none", "read", "write"];
}

/** Human-readable label for a permission key. */
export function githubAppPermissionLabel(key: GitHubAppPermissionKey): string {
  return key
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export interface GitHubAppEntry {
  id: string;
  name: string;
  appId: string;
  privateKeySecretId: string;
  installationId: string | null;
  roles: string[];
  agentIds: string[];
  allowedRepos: string[];
  permissions: GitHubAppPermissions;
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
  /** Anti-CSRF state: POST to GitHub as a separate form field; echoed back on the callback. */
  state: string;
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
