import { and, eq, isNull } from "drizzle-orm";
import { isUuidLike } from "@myrmidon/shared";
import {
  connectionGrants,
  issues,
  projectWorkspaces,
  runIdentityContexts,
  toolConnections,
  agents,
  companySecrets,
  type Db,
} from "@myrmidon/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
// myrmidon(GITHUB-SHARED-IDENTITY): self-hosted GitHub App identities, chosen by the target repository
import { applyGitHubAppIdentity } from "../myrmidon/github-shared-identity/broker.js";
import { normalizeGitHubRepository, readGitHubSharedIdentitySettings, githubAppsFor, githubPatsFor } from "../myrmidon/github-shared-identity/settings.js";
import { onResetGitHubAppTokenCache } from "../myrmidon/github-shared-identity/index.js";
import {
  allowsGitHubCredentialExport,
  GENERIC_DENIAL,
  quarantinedIssueDenial,
  type GitHubCredentialDenial,
} from "./github-credential-policy.js";

export {
  allowsGitHubCredentialExport,
  GENERIC_DENIAL,
  quarantinedIssueDenial,
  type GitHubCredentialDenial,
};

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  // myrmidon(GITHUB-SHARED-IDENTITY): "app" — a self-hosted GitHub App token for `repository`, "pat" — a scoped company-secret PAT
  source?: "personal" | "dedicated" | "app" | "pat";
  repository?: string;
  login?: string;
  reason?: string;
  // myrmidon(GITHUB-SHARED-IDENTITY): machine-readable cause of an `absent` answer and the repository patterns
  // the agent may name, so a client can explain "access exists, say which repository"
  reasonCode?: "repository_required";
  availableRepositories?: string[];
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
  expiresAt?: string;
};

/**
 * myrmidon(GITHUB-SHARED-IDENTITY): the repository of the run's task when the
 * caller named none (`gh auth status` or `gh api user` outside a clone). The
 * task's own workspace wins, then the project's primary workspace; only a
 * single distinct github.com repository counts, anything else stays unknown
 * and the broker answers `repository_required`.
 */
async function inferRunRepository(
  db: Db,
  run: { companyId: string; contextSnapshot?: any; nativeIssueId?: string | null },
): Promise<string | null> {
  const issueId = run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.nativeIssueId;
  if (typeof issueId !== "string" || !isUuidLike(issueId)) return null;
  const [issue] = await db
    .select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
  if (!issue) return null;
  if (issue.projectWorkspaceId) {
    const [own] = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.id, issue.projectWorkspaceId), eq(projectWorkspaces.companyId, run.companyId)));
    const repository = normalizeGitHubRepository(own?.repoUrl);
    if (repository) return repository;
  }
  if (!issue.projectId) return null;
  const rows = await db
    .select({ repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, issue.projectId), eq(projectWorkspaces.companyId, run.companyId)));
  const primary = rows.filter((row) => row.isPrimary).map((row) => normalizeGitHubRepository(row.repoUrl)).find(Boolean);
  if (primary) return primary;
  const distinct = new Set(rows.map((row) => normalizeGitHubRepository(row.repoUrl)).filter((value): value is string => Boolean(value)));
  return distinct.size === 1 ? [...distinct][0]! : null;
}

const GITHUB_CREDENTIAL_CACHE_TTL_MS = 50 * 60 * 1000; // ~50 minutes
const GITHUB_CREDENTIAL_CACHE_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

interface CachedGitHubCredentialResult {
  identityContextId: string | null;
  revision: number | null;
  status: GitHubCredentialSummary["status"];
  source?: GitHubCredentialSummary["source"];
  repository?: string;
  login?: string;
  connectionId?: string | null;
  grantId?: string | null;
  authenticationMode?: string;
  expiresAt?: string;
  reason?: string;
  env: Record<string, string>;
}

interface CachedGitHubCredentialEntry {
  result: CachedGitHubCredentialResult;
  cachedAt: number;
  expiresAt?: number;
}

const githubCredentialCache = new Map<string, CachedGitHubCredentialEntry>();

export function clearGitHubOperationCredentialCache(): void {
  githubCredentialCache.clear();
}

onResetGitHubAppTokenCache(clearGitHubOperationCredentialCache);

function credentialExpiresAt(summary: GitHubCredentialSummary): number | undefined {
  if (!summary.expiresAt) return undefined;
  const expiresAt = Date.parse(summary.expiresAt);
  return Number.isFinite(expiresAt) ? expiresAt : undefined;
}

function cachedCredentialIsFresh(entry: CachedGitHubCredentialEntry, now: number): boolean {
  if (now - entry.cachedAt >= GITHUB_CREDENTIAL_CACHE_TTL_MS) return false;
  return entry.expiresAt === undefined
    || now < entry.expiresAt - GITHUB_CREDENTIAL_CACHE_EXPIRY_MARGIN_MS;
}

async function isCachedCredentialStillActive(
  db: Db,
  companyId: string,
  agentId: string,
  connectionId?: string | null,
  grantId?: string | null,
  credential?: { source?: string; repository?: string },
): Promise<boolean> {
  try {
    if (connectionId) {
      const rows = await db
        .select({ enabled: toolConnections.enabled, status: toolConnections.status })
        .from(toolConnections)
        .where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, companyId)));
      if (!rows.length || !rows[0].enabled || rows[0].status !== "active") return false;
    }
    if (grantId) {
      const rows = await db
        .select({ status: connectionGrants.status })
        .from(connectionGrants)
        .where(and(eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, companyId)));
      if (!rows.length || rows[0].status !== "active") return false;
    }
    const [agent] = await db
      .select({ role: agents.role, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent || agent.status !== "active" || agent.role === "viewer") return false;
    const shared = await readGitHubSharedIdentitySettings(db, companyId);
    const repo = normalizeGitHubRepository(credential?.repository);
    if (shared.enabled && repo) {
      const patMatches = githubPatsFor(shared, agentId, repo);
      const appMatches = githubAppsFor(shared, { id: agentId, role: agent.role }, repo);
      for (const pat of patMatches) {
        const [secret] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
          eq(companySecrets.id, pat.tokenSecretId), eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "company"), eq(companySecrets.status, "active"),
          isNull(companySecrets.deletedAt),
        ));
        if (!secret) return false;
      }
      for (const app of appMatches) {
        const [secret] = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
          eq(companySecrets.id, app.privateKeySecretId), eq(companySecrets.companyId, companyId),
          eq(companySecrets.scope, "company"), eq(companySecrets.status, "active"),
          isNull(companySecrets.deletedAt),
        ));
        if (!secret) return false;
      }
      if (credential?.source === "app" && appMatches.length === 0) return false;
      if (credential?.source === "pat" && patMatches.length === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    // myrmidon(GITHUB-SHARED-IDENTITY): `owner/repo` (or a github.com remote) the operation targets
    repository?: string | null;
  },
) {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");

  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  const denial = await allowsGitHubCredentialExport(db, run);
  if (!denial.allowed) {
    summary = {
      status: "unavailable",
      reason: denial.reason ?? GENERIC_DENIAL.reason,
    };
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }

  const normalizedRepo = normalizeGitHubRepository(input.repository) ?? "";
  const cacheKey = `${input.companyId}:${input.agentId}:${input.runId}:${context.id}:${context.revision}:${context.responsibleUserId ?? "none"}:${normalizedRepo}`;
  const cached = githubCredentialCache.get(cacheKey);
  if (cached && cachedCredentialIsFresh(cached, Date.now())) {
    const active = await isCachedCredentialStillActive(
      db,
      input.companyId,
      input.agentId,
      cached.result.connectionId,
      cached.result.grantId,
      cached.result,
    );
    if (!active) {
      githubCredentialCache.delete(cacheKey);
    } else {
      return cached.result;
    }
  } else if (cached) {
    githubCredentialCache.delete(cacheKey);
  }
  try {
    const resolved = await resolveManagedGitHubCredential(
      db,
      secretService(db),
      input.companyId,
      {
        agentId: input.agentId,
        heartbeatRunId: input.runId,
        allowStandingDelegation: false,
        responsibleUserId:
          context?.cause === "company_default"
            ? null
            : (context?.responsibleUserId ?? null),
        issueId:
          typeof run.contextSnapshot?.issueId === "string"
            ? run.contextSnapshot.issueId
            : null,
      },
    );
    if (resolved.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
        expiresAt:
          resolved.credential.source === "managed_connection"
            ? resolved.credential.expiresAt
            : undefined,
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
      // myrmidon(GITHUB-SHARED-IDENTITY): no dedicated/personal/delegated OAuth
      // grant for this run — a self-hosted GitHub App may serve the repository.
      if (!resolved.configured || resolved.noCandidate) {
        const app = await applyGitHubAppIdentity(db, {
          companyId: input.companyId,
          agentId: input.agentId,
          runId: input.runId,
          issueId:
            typeof run.contextSnapshot?.issueId === "string"
              ? run.contextSnapshot.issueId
              : null,
          responsibleUserId:
            context?.cause === "company_default"
              ? null
              : (context?.responsibleUserId ?? null),
          repository: normalizeGitHubRepository(input.repository) ?? (await inferRunRepository(db, run)),
        });
        if (app) {
          summary = app.summary;
          if (app.expiresAt) summary.expiresAt = app.expiresAt;
          env = app.env;
        }
      }
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }

  if (context)
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  const result: CachedGitHubCredentialResult = {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
  if (summary.status === "available" && Object.keys(env).length > 0) {
    if (githubCredentialCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of githubCredentialCache.entries()) {
        if (!cachedCredentialIsFresh(v, now)) githubCredentialCache.delete(k);
      }
    }
    githubCredentialCache.set(cacheKey, {
      result,
      cachedAt: Date.now(),
      expiresAt: credentialExpiresAt(summary),
    });
  }
  return result;
}
