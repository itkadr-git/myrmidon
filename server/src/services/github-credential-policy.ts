import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@myrmidon/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  type Db,
} from "@myrmidon/db";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

export const GENERIC_DENIAL: {
  allowed: false;
  reason: string;
} = {
  allowed: false,
  reason:
    "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
};

export type GitHubCredentialDenial =
  | { allowed: true }
  | { allowed: false; reason: string };

export function quarantinedIssueDenial(
  identifier: string | null | undefined,
  issueId: string,
): { allowed: false; reason: string } {
  const label = identifier ?? "this issue";
  return {
    allowed: false,
    reason:
      `GitHub credentials are withheld because the task (${label}) is quarantined as low-trust source material ` +
      `(its creation run carried untrusted provenance — see issues.source_trust.disposition=quarantined), not because ` +
      `the agent lacks permissions. This run cannot lift the quarantine itself. Ask a human operator to release it via ` +
      `POST /api/issues/${issueId}/low-trust/promotions (board: “promote from low-trust”), then rerun the GitHub operation.`,
  };
}

export async function allowsGitHubCredentialExport(
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
