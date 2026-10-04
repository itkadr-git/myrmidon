// server/src/myrmidon/github-shared-identity/settings.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): access rules of the shared GitHub
// authorizations — "authorize once for the whole server", one identity per
// product.
//
// A shared authorization lives in the vendor tool-connections model: a
// managed GitHub connection with the `shared` credential policy and ONE
// `organization` grant, created by one OAuth pass (the GitHub App is installed
// on the chosen repositories during that pass) and installed with a company
// target. A company may hold several — for example one GitHub account for the
// repositories of one product and a separate bot account for another. This
// document says, per shared connection, who may use it and for which
// repositories:
//
//   - `enabled` — master switch; off means no shared grant serves anybody and
//     shared connections do not count as "configured" for any agent;
//   - `connections[]` — one rule per shared connection: `roles` / `agentIds`
//     (agents that may use it; both empty means nobody) and `allowedRepos`
//     (`owner/repo` patterns; empty means none);
//   - `commitEmailDomain` — the domain of the agent's commit email
//     (`<agent>@<domain>`): the commit identity stays the agent's, only the
//     authentication is shared.
//
// The broker picks the identity by the target repository of each operation:
// the one shared connection whose rule allows the agent and matches the
// repository. A repository matched by none gets no shared identity (absent);
// a repository matched by two connections of different GitHub accounts is an
// error, never a silent pick — identities of different products never mix.
// The broker re-reads the document on every request: a change applies to the
// next git/gh operation without a restart. A dedicated (per-agent) grant, or
// the run's own personal grant, always wins over a shared grant.

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

/** The rule of one shared GitHub connection. */
export const githubSharedConnectionRuleSchema = z
  .object({
    connectionId: z.string().uuid(),
    ...agentScopeFields,
    allowedRepos: z.array(repoPatternSchema).max(MAX_ALLOWED_REPOS).default([]),
  })
  .strict();

export const MAX_SHARED_CONNECTIONS = 20;

/** The document a board PUT replaces. */
export const githubSharedIdentitySettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    connections: z.array(githubSharedConnectionRuleSchema).max(MAX_SHARED_CONNECTIONS).default([]),
    commitEmailDomain: z.string().trim().toLowerCase().regex(EMAIL_DOMAIN, "Not a domain name").nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.connections.forEach((rule, index) => {
      if (seen.has(rule.connectionId)) {
        ctx.addIssue({ code: "custom", path: ["connections", index, "connectionId"], message: "One rule per connection" });
      }
      seen.add(rule.connectionId);
    });
  });

export type GitHubSharedIdentitySettingsInput = z.input<typeof githubSharedIdentitySettingsInputSchema>;
export type GitHubSharedConnectionRule = z.output<typeof githubSharedConnectionRuleSchema>;

export interface GitHubSharedIdentitySettings {
  version: 1;
  enabled: boolean;
  connections: GitHubSharedConnectionRule[];
  commitEmailDomain: string | null;
}

export function defaultGitHubSharedIdentitySettings(): GitHubSharedIdentitySettings {
  return { version: 1, enabled: false, connections: [], commitEmailDomain: null };
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
    connections: input.connections.map((rule) => ({
      connectionId: rule.connectionId,
      roles: dedupe(rule.roles),
      agentIds: dedupe(rule.agentIds),
      allowedRepos: dedupe(rule.allowedRepos, true),
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

/** Whether a connection rule lets this agent use that shared connection. */
export function sharedRuleAllowsAgent(
  rule: Pick<GitHubSharedConnectionRule, "roles" | "agentIds">,
  agent: { id: string; role: string | null | undefined },
): boolean {
  if (rule.agentIds.includes(agent.id)) return true;
  const role = typeof agent.role === "string" ? agent.role : "";
  return Boolean(role) && rule.roles.includes(role);
}

/**
 * The shared connections that may serve this agent for this repository
 * (normalized `owner/repo`): enabled rules that allow the agent and whose
 * patterns match the repository. Usually zero or one; two or more is an
 * overlap the resolver reports as an error.
 */
export function sharedConnectionIdsFor(
  settings: GitHubSharedIdentitySettings,
  agent: { id: string; role: string | null | undefined },
  repository: string | null,
): string[] {
  if (!settings.enabled || !repository) return [];
  return settings.connections
    .filter((rule) => sharedRuleAllowsAgent(rule, agent) && isRepositoryAllowed(rule.allowedRepos, repository))
    .map((rule) => rule.connectionId);
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
