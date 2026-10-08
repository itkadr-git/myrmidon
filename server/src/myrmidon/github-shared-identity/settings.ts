// server/src/myrmidon/github-shared-identity/settings.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): "authorize once for the whole server"
// through self-hosted GitHub Apps — one identity per product, no vendor cloud
// connector and no vendor GitHub App.
//
// The operator registers OUR OWN GitHub App under each account or
// organization (for example one for product A's owner account, one for
// product B's bot account) and installs it on that product's repositories.
// This document, per company, lists those Apps:
//
//   - `enabled` — master switch; off means no App serves anybody;
//   - `apps[]` — one entry per App installation: the App id, the company
//     secret holding its private key (PEM), the installation id (optional:
//     discovered per repository when empty), the agents that may use it
//     (`roles` / `agentIds`; both empty means nobody) and the repositories it
//     serves (`allowedRepos`, `owner/repo` patterns; empty means none);
//   - `commitEmailDomain` — the domain of the agent's commit email
//     (`<agent>@<domain>`): the commit identity stays the agent's, only the
//     authentication is shared.
//
// The board mints short-lived installation tokens itself (server-side JWT
// signed with the App key, `POST /app/installations/{id}/access_tokens`),
// narrowed to the ONE target repository and to contents + pull requests
// read/write and metadata read — never secrets, administration or
// workflows. The broker picks the App by the target repository of each
// operation; a repository matched by two Apps is an error, never a silent
// pick, so identities of different products never mix. The document is
// re-read on every request: a change applies to the next git/gh operation
// without a restart. A dedicated (per-agent) OAuth grant, or the run's own
// personal grant, wins over an App.

import { z } from "zod";

/** Key of the per-company map under `instance_settings.general`. */
export const GITHUB_SHARED_IDENTITY_GENERAL_KEY = "myrmidonGithubSharedIdentity";

/** Reserved (RFC 2606) default: never routable, never a real mailbox. */
export const DEFAULT_COMMIT_EMAIL_DOMAIN = "agents.myrmidon.invalid";

/** GitHub logins / organization names: alphanumerics and single hyphens, at most 39 characters. */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** A repository name as GitHub accepts it. */
const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** A repository-name pattern: the same alphabet plus `*`. */
const GITHUB_REPO_NAME_PATTERN = /^[A-Za-z0-9._*-]{1,100}$/;
/** A DNS name for the commit email domain. */
const EMAIL_DOMAIN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const MAX_ALLOWED_REPOS = 200;
export const MAX_SCOPE_ENTRIES = 500;

/**
 * A repository pattern: `owner/repo`, or `owner/<glob>` where `*` in the
 * repository part matches any run of name characters (`owner/*`,
 * `owner/service-*`). The owner is always literal — a pattern can never
 * widen to another account's repositories.
 */
export function isValidRepoPattern(pattern: string): boolean {
  const parts = pattern.trim().split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts as [string, string];
  return GITHUB_OWNER.test(owner) && GITHUB_REPO_NAME_PATTERN.test(repo) && repo !== "." && repo !== "..";
}

const repoPatternSchema = z
  .string()
  .trim()
  .min(3)
  .max(140)
  .refine(isValidRepoPattern, { message: "Use owner/repo or owner/<pattern with *>; the owner must be literal" });

const agentScopeFields = {
  roles: z.array(z.string().trim().min(1).max(64)).max(MAX_SCOPE_ENTRIES).default([]),
  agentIds: z.array(z.string().uuid()).max(MAX_SCOPE_ENTRIES).default([]),
};

/** One self-hosted GitHub App installation and who may use it for what. */
export const githubAppEntrySchema = z
  .object({
    /** Stable id of the entry (the UI generates it). */
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    /** The GitHub App id (numeric). */
    appId: z.string().trim().regex(/^[0-9]{1,20}$/, "The GitHub App id is a number"),
    /** Company secret (company scope) holding the App's private key, PEM. */
    privateKeySecretId: z.string().uuid(),
    /** Installation id; null — discovered per repository (GET /repos/{owner}/{repo}/installation). */
    installationId: z.string().trim().regex(/^[0-9]{1,20}$/).nullable().default(null),
    // myrmidon(GITHUB-APP-MANIFEST): the App's GitHub slug (from the manifest
    // flow; manually registered Apps may leave it null) — backs the
    // one-click "Install" URL. Additive; no migration (instance_settings JSON).
    slug: z.string().trim().min(1).max(100).nullable().default(null),
    ...agentScopeFields,
    allowedRepos: z.array(repoPatternSchema).max(MAX_ALLOWED_REPOS).default([]),
  })
  .strict();

export const MAX_GITHUB_APPS = 20;

/** The document a board PUT replaces. */
export const githubSharedIdentitySettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    apps: z.array(githubAppEntrySchema).max(MAX_GITHUB_APPS).default([]),
    commitEmailDomain: z.string().trim().toLowerCase().regex(EMAIL_DOMAIN, "Not a domain name").nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.apps.forEach((app, index) => {
      if (seen.has(app.id)) {
        ctx.addIssue({ code: "custom", path: ["apps", index, "id"], message: "Duplicate entry id" });
      }
      seen.add(app.id);
    });
  });

export type GitHubSharedIdentitySettingsInput = z.input<typeof githubSharedIdentitySettingsInputSchema>;
export type GitHubAppEntry = z.output<typeof githubAppEntrySchema>;

export interface GitHubSharedIdentitySettings {
  version: 1;
  enabled: boolean;
  apps: GitHubAppEntry[];
  commitEmailDomain: string | null;
}

export function defaultGitHubSharedIdentitySettings(): GitHubSharedIdentitySettings {
  return { version: 1, enabled: false, apps: [], commitEmailDomain: null };
}

function dedupe(values: string[], caseInsensitive = false): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Validated input -> the stored document (deduplicated lists, version stamp). */
export function toStoredGitHubSharedIdentitySettings(
  input: z.output<typeof githubSharedIdentitySettingsInputSchema>,
): GitHubSharedIdentitySettings {
  return {
    version: 1,
    enabled: input.enabled,
    apps: input.apps.map((app) => ({
      ...app,
      roles: dedupe(app.roles),
      agentIds: dedupe(app.agentIds),
      allowedRepos: dedupe(app.allowedRepos, true),
    })),
    commitEmailDomain: input.commitEmailDomain,
  };
}

/**
 * Parse whatever is stored. A malformed document reads as the default (off):
 * a broken row must never widen access.
 */
export function parseStoredGitHubSharedIdentitySettings(raw: unknown): GitHubSharedIdentitySettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return defaultGitHubSharedIdentitySettings();
  const { version: _version, ...rest } = raw as Record<string, unknown>;
  const parsed = githubSharedIdentitySettingsInputSchema.safeParse(rest);
  return parsed.success ? toStoredGitHubSharedIdentitySettings(parsed.data) : defaultGitHubSharedIdentitySettings();
}

/**
 * Normalize a repository reference to `owner/repo`, or null when it is not a
 * github.com repository. Accepts what the callers actually hold: the `path`
 * git hands a credential helper (`owner/repo.git`), a bare `owner/repo`, an
 * https remote (`https://github.com/owner/repo.git`) and an scp-style remote
 * (`git@github.com:owner/repo.git`). Anything on another host is rejected.
 */
export function normalizeGitHubRepository(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > 300) return null;
  const scp = /^git@(?:www\.)?github\.com:(.+)$/i.exec(value);
  if (scp) {
    value = scp[1]!;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return null;
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
    value = parsed.pathname;
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  const repo = segments[1]!.replace(/\.git$/i, "");
  if (!GITHUB_OWNER.test(owner) || !GITHUB_REPO_NAME.test(repo) || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[A-Za-z0-9._-]*");
  return new RegExp(`^${body}$`, "i");
}

/** True when `repository` (normalized `owner/repo`) matches one of the patterns. */
export function isRepositoryAllowed(patterns: readonly string[], repository: string): boolean {
  const [owner, repo] = repository.split("/") as [string, string | undefined];
  if (!repo) return false;
  return patterns.some((pattern) => {
    if (!isValidRepoPattern(pattern)) return false;
    const [patternOwner, patternRepo] = pattern.trim().split("/") as [string, string];
    return patternOwner.toLowerCase() === owner.toLowerCase() && globToRegExp(patternRepo).test(repo);
  });
}

/** Whether an App entry lets this agent use it. */
export function appEntryAllowsAgent(
  entry: Pick<GitHubAppEntry, "roles" | "agentIds">,
  agent: { id: string; role: string | null | undefined },
): boolean {
  if (entry.agentIds.includes(agent.id)) return true;
  const role = typeof agent.role === "string" ? agent.role : "";
  return Boolean(role) && entry.roles.includes(role);
}

/**
 * The App entries that may serve this agent for this repository (normalized
 * `owner/repo`): the entries that allow the agent and whose patterns match.
 * Zero — no App identity; one — that App; two or more — an overlap the
 * broker reports as an error.
 */
export function githubAppsFor(
  settings: GitHubSharedIdentitySettings,
  agent: { id: string; role: string | null | undefined },
  repository: string | null,
): GitHubAppEntry[] {
  if (!settings.enabled || !repository) return [];
  return settings.apps.filter((entry) => appEntryAllowsAgent(entry, agent) && isRepositoryAllowed(entry.allowedRepos, repository));
}

/**
 * The commit identity of an agent under the shared authorization: the agent's
 * own name, and `<slug>@<domain>`. The shared GitHub account authenticates the
 * push; it never becomes the author.
 */
export function agentCommitIdentity(
  agent: { id: string; name: string },
  settings: Pick<GitHubSharedIdentitySettings, "commitEmailDomain">,
): { name: string; email: string } {
  const name = agent.name.replace(/[\r\n<>]/g, " ").trim() || `agent-${agent.id.slice(0, 8)}`;
  const slug = agent.name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `agent-${agent.id.slice(0, 8)}`;
  return { name, email: `${slug}@${settings.commitEmailDomain ?? DEFAULT_COMMIT_EMAIL_DOMAIN}` };
}
