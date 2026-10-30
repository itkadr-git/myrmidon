// server/src/myrmidon/guard-return/sweep.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Sweep running every 5 minutes to return stranded
// code tasks from non-coding roles (reviewer, lead, operator) to the PR author or returnAssignee.

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  issueComments,
  issues,
  issueWorkProducts,
  projects,
  type Db,
} from "@myrmidon/db";
import { logger as rootLogger } from "../../../middleware/logger.js";
import {
  DEFAULT_GUARD_RETURN_SWEEP_INTERVAL_SEC,
  GUARD_RETURN_ACTIVITY_ACTION,
  NONCODING_ROLES,
  buildGuardReturnWakePayload,
  decideGuardReturn,
  type AgentSummary,
  type CommentSummary,
  type GuardReturnCandidate,
  type PrWorkProductSummary,
} from "./domain.js";

export interface GuardReturnSweepDeps {
  db: Db;
  wakeup: (agentId: string, options: Record<string, unknown>) => Promise<unknown>;
  logger?: typeof rootLogger;
  intervalSec?: number;
}

export interface SweepResult {
  candidateCount: number;
  returnedCount: number;
  skipped: boolean;
  returnedIssueIds: string[];
}

export function createGuardReturnSweep(deps: GuardReturnSweepDeps) {
  const logger = deps.logger ?? rootLogger;
  let lastSweepAtMs = 0;

  function configuredIntervalMs(): number {
    const raw = process.env.MYRMIDON_GUARD_RETURN_INTERVAL_SEC;
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed * 1000;
    }
    return (deps.intervalSec ?? DEFAULT_GUARD_RETURN_SWEEP_INTERVAL_SEC) * 1000;
  }

  async function sweep(now = new Date(), options?: { force?: boolean }): Promise<SweepResult> {
    const nowMs = now.getTime();
    const intervalMs = configuredIntervalMs();

    if (!options?.force && lastSweepAtMs > 0 && nowMs - lastSweepAtMs < intervalMs) {
      return {
        candidateCount: 0,
        returnedCount: 0,
        skipped: true,
        returnedIssueIds: [],
      };
    }
    lastSweepAtMs = nowMs;

    // Find candidate issues in status in_progress or in_review, assigned to an agent
    const candidateRows = await deps.db
      .select({
        issueId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        casteKey: issues.casteKey,
        labels: issues.labels,
        executionState: issues.executionState,
        harnessKind: issues.harnessKind,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        assigneeRole: agents.role,
        assigneeName: agents.name,
        projectDefaultCasteKey: projects.defaultCasteKey,
      })
      .from(issues)
      .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          inArray(issues.status, ["in_progress", "in_review"]),
          isNull(issues.hiddenAt),
          inArray(agents.role, Array.from(NONCODING_ROLES)),
        ),
      );

    if (candidateRows.length === 0) {
      return {
        candidateCount: 0,
        returnedCount: 0,
        skipped: false,
        returnedIssueIds: [],
      };
    }

    const companyIds = Array.from(new Set(candidateRows.map((r) => r.companyId)));
    const issueIds = candidateRows.map((r) => r.issueId);

    // Load active engineers across these companies
    const allEngineers = await deps.db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          inArray(agents.companyId, companyIds),
          eq(agents.role, "engineer"),
          ne(agents.status, "retired"),
        ),
      );

    const engineersByCompany = new Map<string, AgentSummary[]>();
    for (const eng of allEngineers) {
      const list = engineersByCompany.get(eng.companyId) ?? [];
      list.push(eng);
      engineersByCompany.set(eng.companyId, list);
    }

    // Load all PR work products for these issues
    const prRows = await deps.db
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        type: issueWorkProducts.type,
        status: issueWorkProducts.status,
        externalId: issueWorkProducts.externalId,
        createdByRunId: issueWorkProducts.createdByRunId,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          inArray(issueWorkProducts.issueId, issueIds),
          eq(issueWorkProducts.type, "pull_request"),
        ),
      );

    const prsByIssue = new Map<string, PrWorkProductSummary[]>();
    const runIds: string[] = [];
    for (const pr of prRows) {
      const list = prsByIssue.get(pr.issueId) ?? [];
      list.push(pr);
      prsByIssue.set(pr.issueId, list);
      if (pr.createdByRunId) runIds.push(pr.createdByRunId);
    }

    // Resolve run -> agentId for PR runs
    const runAgentMap = new Map<string, string>();
    if (runIds.length > 0) {
      const runs = await deps.db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, Array.from(new Set(runIds))));
      for (const r of runs) {
        if (r.agentId) runAgentMap.set(r.id, r.agentId);
      }
    }

    // Load agents relevant to these issues (assignees, engineers, run agents, pr authors)
    const neededAgentIds = new Set<string>();
    for (const r of candidateRows) if (r.assigneeAgentId) neededAgentIds.add(r.assigneeAgentId);
    for (const eng of allEngineers) neededAgentIds.add(eng.id);
    for (const aId of runAgentMap.values()) neededAgentIds.add(aId);
    for (const pr of prRows) {
      const meta = (pr.metadata ?? {}) as Record<string, unknown>;
      if (typeof meta.lastCommitAuthorAgentId === "string") neededAgentIds.add(meta.lastCommitAuthorAgentId);
      if (typeof meta.creatorAgentId === "string") neededAgentIds.add(meta.creatorAgentId);
    }

    const agentsList = await deps.db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(inArray(agents.id, Array.from(neededAgentIds)));
    const agentMap = new Map<string, AgentSummary>(agentsList.map((a) => [a.id, a]));

    // Load recent comments for candidate issues
    const commentsRows = await deps.db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorType: issueComments.authorType,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(and(inArray(issueComments.issueId, issueIds), isNull(issueComments.deletedAt)))
      .orderBy(desc(issueComments.createdAt));

    const commentsByIssue = new Map<string, CommentSummary[]>();
    for (const c of commentsRows) {
      const list = commentsByIssue.get(c.issueId) ?? [];
      if (list.length < 10) list.push(c);
      commentsByIssue.set(c.issueId, list);
    }

    const returnedIssueIds: string[] = [];

    // Evaluate each candidate
    for (const row of candidateRows) {
      const candidate: GuardReturnCandidate = {
        issueId: row.issueId,
        identifier: row.identifier,
        title: row.title,
        companyId: row.companyId,
        status: row.status,
        assigneeAgentId: row.assigneeAgentId,
        assigneeRole: row.assigneeRole,
        projectId: row.projectId,
        casteKey: row.casteKey,
        labels: row.labels,
        executionState: row.executionState as Record<string, unknown> | null,
        harnessKind: row.harnessKind,
        executionWorkspacePreference: row.executionWorkspacePreference,
        projectDefaultCasteKey: row.projectDefaultCasteKey,
        prWorkProducts: prsByIssue.get(row.issueId) ?? [],
        comments: commentsByIssue.get(row.issueId) ?? [],
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };

      const activeEngineers = engineersByCompany.get(row.companyId) ?? [];
      const decision = decideGuardReturn(candidate, agentMap, runAgentMap, activeEngineers);

      if (decision.action === "return" && decision.targetAssigneeAgentId) {
        try {
          // 1. Update the issue: status -> in_progress, assignee -> targetAssigneeAgentId
          const nextExecutionState = candidate.executionState
            ? { ...candidate.executionState, status: "in_progress" }
            : null;

          await deps.db
            .update(issues)
            .set({
              status: "in_progress",
              assigneeAgentId: decision.targetAssigneeAgentId,
              executionState: nextExecutionState,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, candidate.issueId));

          // 2. Post comment relaying the remarks and explaining the return
          if (decision.commentBody) {
            await deps.db.insert(issueComments).values({
              companyId: candidate.companyId,
              issueId: candidate.issueId,
              authorType: "system",
              body: decision.commentBody,
            });
          }

          // 3. Wake up the engineer agent
          await deps.wakeup(
            decision.targetAssigneeAgentId,
            {
              source: "on_demand",
              reason: "execution_changes_requested",
              payload: buildGuardReturnWakePayload(candidate.issueId, decision.remarksText ?? null),
            },
          );

          // 4. Record event in activity_log
          await deps.db.insert(activityLog).values({
            companyId: candidate.companyId,
            actorType: "system",
            actorId: "guard_return_sweep",
            action: GUARD_RETURN_ACTIVITY_ACTION,
            entityType: "issue",
            entityId: candidate.issueId,
            details: {
              issueId: candidate.issueId,
              identifier: candidate.identifier,
              previousAssigneeAgentId: candidate.assigneeAgentId,
              previousRole: candidate.assigneeRole,
              newAssigneeAgentId: decision.targetAssigneeAgentId,
              targetKind: decision.targetKind,
              remarksTransmitted: Boolean(decision.remarksText),
              remarksLength: decision.remarksText?.length ?? 0,
            },
          });

          returnedIssueIds.push(candidate.issueId);
          logger.info(
            {
              issueId: candidate.issueId,
              identifier: candidate.identifier,
              previousAssignee: candidate.assigneeAgentId,
              newAssignee: decision.targetAssigneeAgentId,
              targetKind: decision.targetKind,
            },
            "guard-return sweep returned code task to engineer",
          );
        } catch (err) {
          logger.error(
            { err, issueId: candidate.issueId },
            "guard-return sweep failed to return issue",
          );
        }
      }
    }

    return {
      candidateCount: candidateRows.length,
      returnedCount: returnedIssueIds.length,
      skipped: false,
      returnedIssueIds,
    };
  }

  return { sweep };
}
