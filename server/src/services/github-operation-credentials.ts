import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@myrmidon/shared";
import {
  connectionGrants,
  issues,
  projectWorkspaces,
  runIdentityContexts,
  toolConnections,
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
import { normalizeGitHubRepository } from "../myrmidon/github-shared-identity/settings.js";
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

interface CachedGitHubCredentialEntry {
  result: {
    identityContextId: string | null;
    revision: number | null;
    status: GitHubCredentialSummary["status"];
    source?: string;
    login?: string;
    connectionId?: string | null;
    grantId?: string | null;
    authenticationMode?: string;
    reason?: string;
    env: Record<string, string>;
  };
  cachedAt: number;
}

const githubCredentialCache = new Map<string, CachedGitHubCredentialEntry>();

export function clearGitHubOperationCredentialCache(): void {
  githubCredentialCache.clear();
}

onResetGitHubAppTokenCache(clearGitHubOperationCredentialCache);

async function isCachedCredentialStillActive(
  db: Db,
  connectionId?: string | null,
  grantId?: string | null,
): Promise<boolean> {
  try {
    if (connectionId) {
      const rows = await db
        .select({ enabled: toolConnections.enabled })
        .from(toolConnections)
        .where(eq(toolConnections.id, connectionId));
      if (!rows.length || !rows[0].enabled) return false;
    }
    if (grantId) {
      const rows = await db
        .select({ status: connectionGrants.status })
        .from(connectionGrants)
        .where(eq(connectionGrants.id, grantId));
      if (!rows.length || rows[0].status !== "active") return false;
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

  const normalizedRepo = normalizeGitHubRepository(input.repository) ?? "";
  const cacheKey = `${input.companyId}:${input.agentId}:${input.runId}:${context.id}:${context.revision}:${context.responsibleUserId ?? "none"}:${normalizedRepo}`;
  const cached = githubCredentialCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < GITHUB_CREDENTIAL_CACHE_TTL_MS) {
    if (cached.result.connectionId || cached.result.grantId) {
      const active = await isCachedCredentialStillActive(
        db,
        cached.result.connectionId,
        cached.result.grantId,
      );
      if (!active) {
        githubCredentialCache.delete(cacheKey);
      } else {
        return cached.result;
      }
    } else {
      return cached.result;
    }
  }

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
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else {
      summary = {
        status: resolved.configured ? "unavailable" : "absent",
        source: resolved.identitySource ?? "personal",
        reason: resolved.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }

  // myrmidon(GITHUB-SHARED-IDENTITY): if no personal/dedicated identity connected (or unavailable),
  // check whether the company has a GitHub App configured that covers `input.repository` (or the run's task repository).
  if (summary.status !== "available") {
    const targetRepository =
      normalizeGitHubRepository(input.repository) ?? (await inferRunRepository(db, run));
    const appResult = await applyGitHubAppIdentity(db, {
      companyId: input.companyId,
      repository: targetRepository,
      responsibleUserId: context.responsibleUserId ?? null,
      actor: { type: "agent", agentId: input.agentId, companyId: input.companyId },
    });
    if (appResult.status === "available" && appResult.env) {
      summary = {
        status: "available",
        source: appResult.source,
        repository: appResult.repository,
        login: appResult.login,
        authenticationMode: appResult.authenticationMode,
      };
      env = appResult.env;
    } else if (appResult.status === "absent" && appResult.reasonCode === "repository_required") {
      summary = {
        status: "absent",
        reasonCode: "repository_required",
        availableRepositories: appResult.availableRepositories,
        reason: appResult.reason,
      };
    }
  }

  if (context)
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  const result = {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
  if (summary.status === "available" && Object.keys(env).length > 0) {
    if (githubCredentialCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of githubCredentialCache.entries()) {
        if (now - v.cachedAt >= GITHUB_CREDENTIAL_CACHE_TTL_MS) {
          githubCredentialCache.delete(k);
        }
      }
    }
    githubCredentialCache.set(cacheKey, {
      result,
      cachedAt: Date.now(),
    });
  }
  return result;
}
