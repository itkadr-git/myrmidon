// Stack registry (SUA, part B): the read-only GitHub App fallback for the
// release check (STACK-WATCH-LIVE, OPE-12141).
//
// The check authenticates its GitHub reads with MYRMIDON_STACK_GITHUB_TOKEN
// (the `stack.github_token` instance secret) when the operator set one. The
// anonymous 60 req/h per-egress-IP budget is what a shared deployment hits:
// a 403 leaves the component stale with no user token to fix. When no
// instance token is configured, the check now mints a strictly read-only
// installation token from the board's own self-hosted GitHub App
// (myrmidon GITHUB-SHARED-IDENTITY): an App entry serves the release check
// when it grants the system identity (the entry's `roles` contains the
// STACK_CHECK_SYSTEM_ROLE sentinel) and its allowedRepos match the component
// repository. The minted token asks for nothing but metadata + contents
// read, whatever the entry stores — the release check can never carry a
// write permission.
//
// No matching entry — the component simply reads anonymously (the retry and
// stale marking of the check itself still apply). Failures of the App path
// never fail the check: no token is returned and the check continues
// anonymous. Neither the private key, the JWT nor the token is ever logged.
//
// The settings document is per company but the release check is
// instance-wide: one read of instance_settings scans every company's map and
// collects the entries that serve the system identity for the repository.
// More than one match is an ambiguity the check answers with a warning and
// anonymous reads — never a silent pick.

import { eq } from "drizzle-orm";
import { companySecrets, instanceSettings, type Db } from "@myrmidon/db";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/secrets.js";
import {
  GitHubAppTokenError,
  mintGitHubAppInstallationToken,
  type GitHubAppPermissions,
} from "../github-shared-identity/app-token.js";
import {
  GITHUB_SHARED_IDENTITY_GENERAL_KEY,
  githubAppsFor,
  parseStoredGitHubSharedIdentitySettings,
} from "../github-shared-identity/settings.js";

/**
 * The role sentinel an App entry grants the board's own jobs: an entry whose
 * `roles` contain this value may serve the scheduled release check for the
 * repositories in its allowedRepos, without naming any agent.
 */
export const STACK_CHECK_SYSTEM_ROLE = "system";

/** The synthetic identity the release check authenticates App minting with. */
const STACK_CHECK_AGENT = { id: "00000000-0000-4000-8000-000000000000", role: STACK_CHECK_SYSTEM_ROLE };

/** The token the release check mints is read-only, always. */
const STACK_CHECK_READ_ONLY_PERMISSIONS: GitHubAppPermissions = {
  actions: "none",
  checks: "none",
  contents: "read",
  deployments: "none",
  environments: "none",
  issues: "none",
  pull_requests: "none",
  workflows: "none",
};

const SINGLETON_KEY = "default";

export type StackGitHubAppTokenResolution =
  | {
      kind: "issued";
      token: string;
      appId: string;
      entryId: string;
      name: string;
      repository: string;
      companyId: string;
      reused: boolean;
      installationId: string;
    }
  | { kind: "not_applicable" }
  | { kind: "ambiguous"; repository: string; entries: string[] }
  | { kind: "error"; repository: string; reason: string };

/** One App entry that serves the release check, with its owning company. */
interface StackCheckAppMatch {
  companyId: string;
  entry: ReturnType<typeof githubAppsFor>[number];
}

function readCompaniesMap(general: unknown): Record<string, unknown> {
  if (typeof general !== "object" || general === null) return {};
  const value = (general as Record<string, unknown>)[GITHUB_SHARED_IDENTITY_GENERAL_KEY];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The App entries (across every company) that grant the system identity for
 * `repository`. One settings read for the whole instance.
 */
export async function findStackCheckAppEntries(
  db: Pick<Db, "select">,
  repository: string,
): Promise<StackCheckAppMatch[]> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  const companies = readCompaniesMap(row?.general);
  const matches: StackCheckAppMatch[] = [];
  for (const [companyId, stored] of Object.entries(companies)) {
    const settings = parseStoredGitHubSharedIdentitySettings(stored);
    for (const entry of githubAppsFor(settings, STACK_CHECK_AGENT, repository)) {
      matches.push({ companyId, entry });
    }
  }
  return matches;
}

/**
 * A read-only installation token for `repository` from the board's GitHub
 * App, or a non-issued resolution the check answers with anonymous reads.
 * Never throws; never logs credential material.
 */
export async function resolveStackCheckGitHubAppToken(
  db: Db,
  repository: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<StackGitHubAppTokenResolution> {
  let match: StackCheckAppMatch | null = null;
  try {
    const matches = await findStackCheckAppEntries(db, repository);
    if (matches.length === 0) return { kind: "not_applicable" };
    if (matches.length > 1) {
      return { kind: "ambiguous", repository, entries: matches.map((m) => m.entry.name) };
    }
    match = matches[0]!;
  } catch {
    // Settings unreadable: anonymous reads, not a failed check.
    return { kind: "not_applicable" };
  }
  const { companyId, entry } = match;
  let privateKeyPem: string;
  try {
    const [secret] = await db
      .select({ id: companySecrets.id })
      .from(companySecrets)
      .where(eq(companySecrets.id, entry.privateKeySecretId))
      .limit(1);
    if (!secret) return { kind: "error", repository, reason: "The GitHub App private key secret is missing" };
    privateKeyPem = await secretService(db).resolveSecretValue(companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "stack-registry",
        configPath: `github_app:${repository}`,
        actorType: "system",
        actorId: "stack-registry",
      },
    });
  } catch {
    return { kind: "error", repository, reason: "The GitHub App private key could not be read" };
  }
  try {
    const minted = await mintGitHubAppInstallationToken({
      appId: entry.appId,
      privateKeyPem,
      installationId: entry.installationId,
      repository,
      // Strictly read-only, regardless of what the entry stores for agents.
      permissions: STACK_CHECK_READ_ONLY_PERMISSIONS,
      fetchImpl: options.fetchImpl,
    });
    journalIssued(db, companyId, repository, entry.id, entry.appId, minted.installationId, minted.expiresAt, minted.reused);
    return {
      kind: "issued",
      token: minted.token,
      appId: entry.appId,
      entryId: entry.id,
      name: entry.name,
      repository,
      companyId,
      reused: minted.reused,
      installationId: minted.installationId,
    };
  } catch (error) {
    return {
      kind: "error",
      repository,
      reason: error instanceof GitHubAppTokenError ? error.message : "GitHub App token minting failed",
    };
  }
}

/** Audit without credential material; a failed audit entry never fails the check. */
function journalIssued(
  db: Db,
  companyId: string,
  repository: string,
  entryId: string,
  appId: string,
  installationId: string,
  expiresAt: string,
  reused: boolean,
): void {
  void logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "stack-registry",
    action: "myrmidon.stack_check.app_token_issued",
    entityType: "github_app_identity",
    entityId: companyId,
    details: { repository, entryId, appId, installationId, expiresAt, reused },
  }).catch(() => undefined);
}
