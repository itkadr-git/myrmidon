// server/src/myrmidon/github-shared-identity/policy.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): the decisions the GitHub credential
// resolver (server/src/services/git-credentials.ts) delegates to this track:
//
//   - sharedGitHubConnectionsForOperation — which shared GitHub connections
//     may serve this agent for this repository (rules enabled, the
//     connection's rule lists the agent by id or role, and its patterns match
//     the repository). The resolver treats every other shared connection as
//     absent for the operation: it neither resolves nor counts as
//     "configured", so a repository matched by no rule keeps whatever the
//     agent had before (absent and, for server-side git, the legacy fallback).
//   - authorizeSharedGitHubIssuance — re-check ONE issuance of a shared grant
//     right before the token is read (the rules may have changed since the
//     selection) and require the repository to be visible to the grant's
//     GitHub App installation when the grant records that list. Denials are
//     journaled (`myrmidon.github_shared.denied`).
//   - journalSharedGitHubIssuance — the activity-log record of an issuance
//     (`myrmidon.github_shared.issued`: agent, run, repository, connection,
//     grant). The secret store writes its own access event for the same read
//     (config path `github_shared:<owner/repo>`). Neither carries the token.

import { and, eq } from "drizzle-orm";
import { agents, type connectionGrants, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import { readGitHubSharedIdentitySettings } from "./store.js";
import {
  agentCommitIdentity,
  normalizeGitHubRepository,
  sharedConnectionIdsFor,
} from "./settings.js";

type Grant = typeof connectionGrants.$inferSelect;

async function loadAgent(db: Db, companyId: string, agentId: string) {
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  return agent ?? null;
}

export async function sharedGitHubConnectionsForOperation(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  repository: string | null | undefined,
): Promise<Set<string>> {
  const normalized = normalizeGitHubRepository(repository);
  if (!agentId || !normalized) return new Set();
  const settings = await readGitHubSharedIdentitySettings(db, companyId);
  if (!settings.enabled) return new Set();
  const agent = await loadAgent(db, companyId, agentId);
  return agent ? new Set(sharedConnectionIdsFor(settings, agent, normalized)) : new Set();
}

async function journal(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    action: "myrmidon.github_shared.issued" | "myrmidon.github_shared.denied";
    details: Record<string, unknown>;
  },
) {
  try {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: input.action,
      entityType: "github_shared_identity",
      entityId: input.companyId,
      details: input.details,
    });
  } catch {
    // The secret store's access event is the primary audit record; a failed
    // journal entry must not turn an issued credential into an outage.
  }
}

export type SharedGitHubIssuanceDecision =
  | { ok: true; repository: string; commitIdentity: { name: string; email: string } }
  | { ok: false; repository: string | null; error: string };

export async function authorizeSharedGitHubIssuance(
  db: Db,
  input: {
    companyId: string;
    agentId: string | null | undefined;
    runId: string | null | undefined;
    repository: string | null | undefined;
    grant: Grant;
  },
): Promise<SharedGitHubIssuanceDecision> {
  const agentId = input.agentId ?? null;
  const settings = await readGitHubSharedIdentitySettings(db, input.companyId);
  const agent = agentId ? await loadAgent(db, input.companyId, agentId) : null;
  const repository = normalizeGitHubRepository(input.repository);
  const deny = async (reason: string, error: string): Promise<SharedGitHubIssuanceDecision> => {
    if (agent) {
      await journal(db, {
        companyId: input.companyId,
        agentId: agent.id,
        runId: input.runId ?? null,
        action: "myrmidon.github_shared.denied",
        details: { repository, reason, connectionId: input.grant.connectionId, grantId: input.grant.id },
      });
    }
    return { ok: false, repository, error };
  };
  // Re-checked here, not only at selection: the rules may change between the two.
  if (!agent || !repository || !sharedConnectionIdsFor(settings, agent, repository).includes(input.grant.connectionId)) {
    return deny(
      "rule_mismatch",
      repository
        ? `The shared GitHub authorization is not allowed for ${repository} for this agent`
        : "The shared GitHub authorization is issued per repository, and the request named none",
    );
  }
  const visible = input.grant.providerTenant?.github?.repositories;
  if (
    Array.isArray(visible) &&
    visible.length > 0 &&
    !visible.some((entry) => entry.fullName?.toLowerCase() === repository.toLowerCase())
  ) {
    return deny(
      "repository_not_installed",
      `Repository ${repository} is not part of the GitHub App installation of the shared authorization`,
    );
  }
  return { ok: true, repository, commitIdentity: agentCommitIdentity(agent, settings) };
}

export async function journalSharedGitHubIssuance(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string | null | undefined;
    repository: string;
    grant: Grant;
  },
) {
  await journal(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId ?? null,
    action: "myrmidon.github_shared.issued",
    details: {
      repository: input.repository,
      login: input.grant.providerTenant?.github?.login ?? null,
      connectionId: input.grant.connectionId,
      grantId: input.grant.id,
    },
  });
}
