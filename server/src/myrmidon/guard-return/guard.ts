// server/src/myrmidon/guard-return/guard.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Guard against putting code tasks of dev projects into in_progress on non-coding roles.

import { and, eq, inArray, isNull, ne, notInArray } from "drizzle-orm";
import { agents, issueWorkProducts, heartbeatRuns, projects, type Db } from "@myrmidon/db";
import { unprocessable } from "../../errors.js";
import { isNoncodingRole, isDevProjectCodeIssue } from "./domain.js";

export interface GuardCheckInput {
  companyId: string;
  issue: {
    id?: string;
    labels?: unknown;
    casteKey?: string | null;
    harnessKind?: string | null;
    executionWorkspacePreference?: string | null;
    executionState?: unknown;
    projectId?: string | null;
    status?: string | null;
    assigneeAgentId?: string | null;
  } | null;
  status?: string | null;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  labelNames?: string[];
  casteKey?: string | null;
  harnessKind?: string | null;
  executionWorkspacePreference?: string | null;
}

export async function assertCodeTaskNotInProgressOnNoncodingRole(
  db: Db,
  input: GuardCheckInput,
): Promise<void> {
  const targetStatus = input.status ?? input.issue?.status;
  // Guard specifically targets in_progress
  if (targetStatus !== "in_progress") {
    return;
  }

  const targetAssigneeId = input.assigneeAgentId ?? input.issue?.assigneeAgentId;
  if (!targetAssigneeId) {
    return;
  }

  // Check the assignee's role
  const [assignedAgent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, targetAssigneeId))
    .limit(1);

  if (!assignedAgent || !isNoncodingRole(assignedAgent.role)) {
    return;
  }

  // Check if this is a dev-project code issue
  let projectDefaultCasteKey: string | null = null;
  const projectId = input.projectId ?? input.issue?.projectId;
  if (projectId) {
    const [proj] = await db
      .select({ defaultCasteKey: projects.defaultCasteKey })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    projectDefaultCasteKey = proj?.defaultCasteKey ?? null;
  }

  let prWorkProducts: Array<{ id: string; type: string; createdByRunId: string | null }> = [];
  if (input.issue?.id) {
    prWorkProducts = await db
      .select({
        id: issueWorkProducts.id,
        type: issueWorkProducts.type,
        createdByRunId: issueWorkProducts.createdByRunId,
      })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, input.companyId),
          eq(issueWorkProducts.issueId, input.issue.id),
          eq(issueWorkProducts.type, "pull_request"),
        ),
      );
  }

  const isCode = isDevProjectCodeIssue({
    labels: input.labelNames ?? input.issue?.labels ?? [],
    casteKey: input.casteKey ?? input.issue?.casteKey,
    projectDefaultCasteKey,
    harnessKind: input.harnessKind ?? input.issue?.harnessKind,
    executionWorkspacePreference: input.executionWorkspacePreference ?? input.issue?.executionWorkspacePreference,
    prWorkProducts: prWorkProducts.map((p) => ({
      id: p.id,
      type: p.type,
      status: "active",
      createdByRunId: p.createdByRunId,
    })),
  });

  if (!isCode) {
    return;
  }

  // Issue is a code task being set to / kept in in_progress on a non-coding role.
  // Find a suggested engineer assignee to hint to the caller.
  let suggestedAssignee: { id: string; name: string } | null = null;

  // 1. Check returnAssignee from executionState
  const executionState = input.issue?.executionState as Record<string, unknown> | undefined;
  const returnAssignee = executionState?.returnAssignee as Record<string, unknown> | undefined;
  if (returnAssignee && returnAssignee.type === "agent" && typeof returnAssignee.agentId === "string") {
    const [returnAgent] = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.id, returnAssignee.agentId))
      .limit(1);
    if (returnAgent && returnAgent.role === "engineer") {
      suggestedAssignee = { id: returnAgent.id, name: returnAgent.name };
    }
  }

  // 2. Check PR creator / author
  if (!suggestedAssignee && prWorkProducts.length > 0) {
    for (const pr of prWorkProducts) {
      if (pr.createdByRunId) {
        const [run] = await db
          .select({ agentId: heartbeatRuns.agentId })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, pr.createdByRunId))
          .limit(1);
        if (run?.agentId) {
          const [runAgent] = await db
            .select({ id: agents.id, name: agents.name, role: agents.role })
            .from(agents)
            .where(eq(agents.id, run.agentId))
            .limit(1);
          if (runAgent && runAgent.role === "engineer") {
            suggestedAssignee = { id: runAgent.id, name: runAgent.name };
            break;
          }
        }
      }
    }
  }

  // 3. Fallback to any active engineer in the company
  if (!suggestedAssignee) {
    const [activeEngineer] = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, input.companyId),
          eq(agents.role, "engineer"),
          notInArray(agents.status, ["retired", "terminated"]),
        ),
      )
      .limit(1);
    if (activeEngineer) {
      suggestedAssignee = activeEngineer;
    }
  }

  const roleName = assignedAgent.role ?? "non-engineer";
  const hint = suggestedAssignee
    ? `Assign this code task to engineer ${suggestedAssignee.name} (${suggestedAssignee.id}) or return to PR author.`
    : "Assign this code task in in_progress to an agent with the engineer role or return to PR author.";

  throw unprocessable(
    `This issue requires an engineer. Cannot set or keep in_progress on non-coding role "${roleName}". Suggested assignee: ${suggestedAssignee ? `${suggestedAssignee.name} (${suggestedAssignee.id})` : "an agent with role engineer"}.`,
    {
      code: "issue_requires_engineer",
      issueId: input.issue?.id ?? null,
      assigneeAgentId: targetAssigneeId,
      assigneeRole: roleName,
      suggestedAssigneeAgentId: suggestedAssignee?.id ?? null,
      suggestedAssigneeName: suggestedAssignee?.name ?? null,
      hint,
    },
  );
}
