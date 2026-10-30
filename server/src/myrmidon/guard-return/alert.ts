// server/src/myrmidon/guard-return/alert.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Alert evaluation for code tasks on non-coding roles.
// Triggers an alert when myrmidon_code_tasks_on_noncoding_roles > 0 for longer than 30 minutes.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, issues, issueWorkProducts, projects, type Db } from "@myrmidon/db";
import {
  DEFAULT_NONCODING_ROLE_ALERT_THRESHOLD_MS,
  NONCODING_ROLES,
  isDevProjectCodeIssue,
} from "./domain.js";

export interface NoncodingRoleAlertEvaluation {
  firing: boolean;
  count: number;
  maxDurationMs: number;
  breachedTasks: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    assigneeRole: string;
    durationMs: number;
  }>;
}

export async function evaluateCodeTasksOnNoncodingRolesAlert(
  db: Db,
  companyId?: string,
  now = new Date(),
  thresholdMs = DEFAULT_NONCODING_ROLE_ALERT_THRESHOLD_MS,
): Promise<NoncodingRoleAlertEvaluation> {
  const conditions = [
    inArray(issues.status, ["in_progress", "in_review"]),
    isNull(issues.hiddenAt),
    inArray(agents.role, Array.from(NONCODING_ROLES)),
  ];
  if (companyId) {
    conditions.push(eq(issues.companyId, companyId));
  }

  const candidateRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      companyId: issues.companyId,
      status: issues.status,
      casteKey: issues.casteKey,
      labels: issues.labels,
      harnessKind: issues.harnessKind,
      executionWorkspacePreference: issues.executionWorkspacePreference,
      updatedAt: issues.updatedAt,
      createdAt: issues.createdAt,
      assigneeRole: agents.role,
      defaultCasteKey: projects.defaultCasteKey,
    })
    .from(issues)
    .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
    .leftJoin(projects, eq(issues.projectId, projects.id))
    .where(and(...conditions));

  if (candidateRows.length === 0) {
    return { firing: false, count: 0, maxDurationMs: 0, breachedTasks: [] };
  }

  const issueIds = candidateRows.map((r) => r.id);
  const prRows = await db
    .select({
      issueId: issueWorkProducts.issueId,
      id: issueWorkProducts.id,
      type: issueWorkProducts.type,
      status: issueWorkProducts.status,
    })
    .from(issueWorkProducts)
    .where(
      and(
        inArray(issueWorkProducts.issueId, issueIds),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    );

  const prsByIssue = new Map<string, Array<{ id: string; type: string; status: string }>>();
  for (const pr of prRows) {
    const list = prsByIssue.get(pr.issueId) ?? [];
    list.push(pr);
    prsByIssue.set(pr.issueId, list);
  }

  const breachedTasks: NoncodingRoleAlertEvaluation["breachedTasks"] = [];
  let maxDurationMs = 0;
  let codeTaskCount = 0;

  for (const row of candidateRows) {
    const isCode = isDevProjectCodeIssue({
      labels: row.labels,
      casteKey: row.casteKey,
      projectDefaultCasteKey: row.defaultCasteKey,
      harnessKind: row.harnessKind,
      executionWorkspacePreference: row.executionWorkspacePreference,
      prWorkProducts: (prsByIssue.get(row.id) ?? []).map((p) => ({
        id: p.id,
        type: p.type,
        status: p.status,
      })),
    });

    if (!isCode) continue;
    codeTaskCount++;

    const sinceDate = row.updatedAt ?? row.createdAt;
    const durationMs = Math.max(0, now.getTime() - new Date(sinceDate).getTime());
    if (durationMs > maxDurationMs) {
      maxDurationMs = durationMs;
    }

    if (durationMs >= thresholdMs) {
      breachedTasks.push({
        issueId: row.id,
        identifier: row.identifier,
        title: row.title,
        assigneeRole: row.assigneeRole,
        durationMs,
      });
    }
  }

  return {
    firing: breachedTasks.length > 0,
    count: codeTaskCount,
    maxDurationMs,
    breachedTasks,
  };
}

export async function countCodeTasksOnNoncodingRoles(
  db: Db,
  companyId?: string,
): Promise<number> {
  const result = await evaluateCodeTasksOnNoncodingRolesAlert(db, companyId);
  return result.count;
}
