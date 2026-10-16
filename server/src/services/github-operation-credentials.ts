import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";
// myrmidon(GITHUB-SHARED-IDENTITY): self-hosted GitHub App identities, chosen by the target repository
import { applyGitHubAppIdentity } from "../myrmidon/github-shared-identity/broker.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  // myrmidon(GITHUB-SHARED-IDENTITY): "app" — a self-hosted GitHub App token for `repository`
  source?: "personal" | "dedicated" | "app";
  repository?: string;
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
type GitHubCredentialDenial = {
  allowed: boolean;
  reason?: string;
};
const GENERIC_DENIAL: GitHubCredentialDenial = {
  allowed: false,
  reason:
    "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
};

/**
 * A quarantined-issue denial reads to the executor as "no permissions" unless
 * it names what actually happened (the task itself is in low-trust quarantine)
 * and the one human path that unblocks it (promotion). The agent cannot
 * promote its own output by design, so the message must point at the operator
 * route instead of letting the agent restate the refusal as a rights problem.
 */
function quarantinedIssueDenial(issueIdentifier: string | null | undefined, issueId: string): GitHubCredentialDenial {
  const label = issueIdentifier ?? "this issue";
  return {
    allowed: false,
    reason:
      `GitHub credentials are withheld because the task (${label}) is quarantined as low-trust source material ` +
      `(its creation run carried untrusted provenance — see issues.source_trust.disposition=quarantined), not because ` +
      `the agent lacks permissions. This run cannot lift the quarantine itself. Ask a human operator to release it via ` +
      `POST /api/issues/${issueId}/low-trust/promotions (board: “promote from low-trust”), then rerun the GitHub operation.`,
  };
}

async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<GitHubCredentialDenial> {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return GENERIC_DENIAL;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return GENERIC_DENIAL;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            id: issues.id,
            identifier: issues.identifier,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return GENERIC_DENIAL;
  if (isLowTrustQuarantined(issue?.sourceTrust))
    return quarantinedIssueDenial(issue!.identifier, issue!.id);
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return GENERIC_DENIAL;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return GENERIC_DENIAL;
  const resolution = resolveCoreTrustPreset({
    companyId: run.companyId,
    agent,
    project,
    issue,
    run: {
      companyId: run.companyId,
      executionPolicy: run.contextSnapshot?.executionPolicy,
    },
  });
  if (resolution.kind === "standard") return { allowed: true };
  return {
    allowed: false,
    reason:
      GENERIC_DENIAL.reason +
      ` (trust preset resolved: ${resolution.kind}${"detail" in resolution && resolution.detail ? ` — ${resolution.detail}` : ""})`,
  };
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
          repository: input.repository ?? null,
        });
        if (app) {
          summary = app.summary;
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
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}
