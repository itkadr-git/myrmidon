// server/src/myrmidon/github-shared-identity/resolve.ts
//
// myrmidon(GITHUB-SHARED-IDENTITY): issue a self-hosted GitHub App identity
// for one run and one repository.
//
// The run-scoped broker calls this only when no OAuth identity candidate
// exists for the run (no dedicated, personal or delegated grant — those
// win). The decision is re-made on every request from the stored rules, the
// agent's current role and the repository the caller names:
//
//   - no repository, or no App entry matches     -> not_applicable (broker keeps "absent")
//   - two or more App entries match              -> ambiguous      (broker: unavailable)
//   - the key secret / GitHub fails              -> error          (broker: unavailable)
//   - otherwise                                  -> issued (a token for that one repository)
//
// Audit, never with the token: the secret store's access event for the
// private-key read (consumer `workspace-git-credential`, the agent, the run,
// the issue, config path `github_app:<owner/repo>`), and an activity entry
// `myrmidon.github_app.issued` (repository, App entry, installation, token
// expiry). Failures are journaled as `myrmidon.github_app.denied`.

import { and, eq, isNull } from "drizzle-orm";
import { agents, companySecrets, type Db } from "@paperclipai/db";
import { logActivity } from "../../services/activity-log.js";
import type { GitCredential } from "../../services/git-credentials.js";
import { readGitHubSharedIdentitySettings } from "./store.js";
import { agentCommitIdentity, githubAppsFor, normalizeGitHubRepository } from "./settings.js";
import { GitHubAppTokenError, mintGitHubAppInstallationToken } from "./app-token.js";

/** The secret-store surface this module needs (a subset of secretService). */
export type GitHubAppSecretsDeps = {
  resolveSecretValue: (
    companyId: string,
    secretId: string,
    version: number | "latest",
    options?: {
      accessContext?: {
        consumerType: "system";
        consumerId: string;
        configPath?: string | null;
        actorType?: "agent" | "user" | "system" | "plugin";
        actorId?: string | null;
        issueId?: string | null;
        heartbeatRunId?: string | null;
        responsibleUserId?: string | null;
      };
    },
  ) => Promise<string>;
};

export type GitHubAppResolution =
  | { kind: "not_applicable" }
  | { kind: "ambiguous"; repository: string; entries: string[] }
  | { kind: "error"; repository: string; entryId: string; name: string; reason: string }
  | {
      kind: "issued";
      repository: string;
      entryId: string;
      name: string;
      installationId: string;
      expiresAt: string;
      credential: GitCredential;
    };

async function journal(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    action: "myrmidon.github_app.issued" | "myrmidon.github_app.denied";
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
      entityType: "github_app_identity",
      entityId: input.companyId,
      details: input.details,
    });
  } catch {
    // The secret store's access event is the primary audit record; a failed
    // journal entry must not turn an issued credential into an outage.
  }
}

export async function resolveGitHubAppCredential(
  db: Db,
  secrets: GitHubAppSecretsDeps,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string | null;
    responsibleUserId?: string | null;
    repository?: string | null;
    fetchImpl?: typeof fetch;
  },
): Promise<GitHubAppResolution> {
  const repository = normalizeGitHubRepository(input.repository);
  if (!repository) return { kind: "not_applicable" };
  const settings = await readGitHubSharedIdentitySettings(db, input.companyId);
  if (!settings.enabled) return { kind: "not_applicable" };
  const [agent] = await db
    .select({ id: agents.id, name: agents.name, role: agents.role })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
  if (!agent) return { kind: "not_applicable" };
  const matches = githubAppsFor(settings, agent, repository);
  if (matches.length === 0) return { kind: "not_applicable" };
  if (matches.length > 1) {
    await journal(db, {
      companyId: input.companyId,
      agentId: agent.id,
      runId: input.runId,
      action: "myrmidon.github_app.denied",
      details: { repository, reason: "ambiguous", entries: matches.map((entry) => entry.id) },
    });
    return { kind: "ambiguous", repository, entries: matches.map((entry) => entry.name) };
  }
  const entry = matches[0]!;
  const fail = async (reason: string): Promise<GitHubAppResolution> => {
    await journal(db, {
      companyId: input.companyId,
      agentId: agent.id,
      runId: input.runId,
      action: "myrmidon.github_app.denied",
      details: { repository, reason, entryId: entry.id, appId: entry.appId },
    });
    return { kind: "error", repository, entryId: entry.id, name: entry.name, reason };
  };

  const [secret] = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(
      and(
        eq(companySecrets.id, entry.privateKeySecretId),
        eq(companySecrets.companyId, input.companyId),
        eq(companySecrets.scope, "company"),
        eq(companySecrets.status, "active"),
        isNull(companySecrets.deletedAt),
      ),
    );
  if (!secret) return fail("The GitHub App private key secret is missing or inactive");
  let privateKeyPem: string;
  try {
    privateKeyPem = await secrets.resolveSecretValue(input.companyId, secret.id, "latest", {
      accessContext: {
        consumerType: "system",
        consumerId: "workspace-git-credential",
        configPath: `github_app:${repository}`,
        actorType: "agent",
        actorId: agent.id,
        issueId: input.issueId ?? null,
        heartbeatRunId: input.runId,
        responsibleUserId: input.responsibleUserId ?? null,
      },
    });
  } catch {
    // Provider errors can carry response bodies; never pass them on.
    return fail("The GitHub App private key could not be read");
  }
  let minted;
  try {
    minted = await mintGitHubAppInstallationToken({
      appId: entry.appId,
      privateKeyPem,
      installationId: entry.installationId,
      repository,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    return fail(error instanceof GitHubAppTokenError ? error.message : "GitHub App token minting failed");
  }
  await journal(db, {
    companyId: input.companyId,
    agentId: agent.id,
    runId: input.runId,
    action: "myrmidon.github_app.issued",
    details: {
      repository,
      entryId: entry.id,
      appId: entry.appId,
      installationId: minted.installationId,
      expiresAt: minted.expiresAt,
      reused: minted.reused,
    },
  });
  return {
    kind: "issued",
    repository,
    entryId: entry.id,
    name: entry.name,
    installationId: minted.installationId,
    expiresAt: minted.expiresAt,
    credential: {
      token: minted.token,
      source: "github_app",
      secretName: null,
      identitySource: "app",
      commitIdentity: agentCommitIdentity(agent, settings),
    },
  };
}
