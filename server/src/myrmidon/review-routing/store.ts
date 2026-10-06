// myrmidon(REVIEW-ROUTING): the database half of the sweep.
//
// Reads are plain selects; the one write path is `applyPatch`, which re-reads
// the issue under a row lock, lets the caller re-check its premise against the
// FRESH row, and only then applies the patch through the ordinary issue
// service (never a hand-rolled UPDATE). A racing writer (a human assigning a
// reviewer, another sweep process) therefore makes the guard fail instead of
// being overwritten.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { activityLog, agents, companies, issues, type Db } from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { REVIEW_ROUTING_ASSIGNED_ACTION, REVIEW_ROUTING_REASSIGNED_ACTION } from "@paperclipai/shared";
import type { RoutingIssue } from "./policy.js";

export interface InReviewIssueRow extends RoutingIssue {
  companyId: string;
  identifier: string | null;
  title: string;
}

export interface ReviewerAgentRow {
  id: string;
  role: string;
}

export interface RoutingHistory {
  lastAt: Date;
  /** Every reviewer this routing has put on the task, oldest first. */
  reviewerAgentIds: string[];
}

export interface ReviewRoutingStore {
  listActiveCompanyIds(): Promise<string[]>;
  listInReviewIssues(companyId: string, limit: number): Promise<InReviewIssueRow[]>;
  /** Invokable agents of the company whose role is one of `roles`. */
  listReviewerAgents(companyId: string, roles: readonly string[]): Promise<ReviewerAgentRow[]>;
  /** Tasks in flight (in progress + in review) per assignee agent. */
  loadByAgent(companyId: string): Promise<Map<string, number>>;
  routingHistory(companyId: string, issueIds: readonly string[]): Promise<Map<string, RoutingHistory>>;
  /**
   * Re-reads the issue under a lock, applies `build(fresh)` when `guard(fresh)`
   * holds, and returns the updated row; null when the guard failed, the row is
   * gone, or the update was refused.
   */
  applyPatch(input: {
    issueId: string;
    companyId: string;
    guard: (fresh: RoutingIssue) => boolean;
    build: (fresh: RoutingIssue) => Record<string, unknown> | null;
  }): Promise<{ executionState: Record<string, unknown> | null } | null>;
}

/** Service layer loaded lazily, for the same startup-graph reason as the stale-block sweep. */
async function loadIssueService() {
  const module = await import("../../services/issues.js");
  return module.issueService;
}

function toRoutingIssue(row: typeof issues.$inferSelect): RoutingIssue {
  return {
    id: row.id,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    responsibleUserId: row.responsibleUserId ?? null,
    executionPolicy: row.executionPolicy,
    executionState: row.executionState,
    // myrmidon(HUMAN-REVIEW-WAIT): the human wait must reach issueNeedsReviewer.
    reviewPolicy: row.reviewPolicy ?? null,
  };
}

export function createPgReviewRoutingStore(db: Db): ReviewRoutingStore {
  return {
    async listActiveCompanyIds() {
      const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
      return rows.map((row) => row.id);
    },

    async listInReviewIssues(companyId, limit) {
      const rows = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_review"),
            isNull(issues.hiddenAt),
            isNull(issues.conversationAgentId),
            isNull(issues.conversationUserId),
          ),
        )
        .orderBy(issues.updatedAt, issues.id)
        .limit(limit);
      return rows.map((row) => ({
        ...toRoutingIssue(row),
        companyId: row.companyId,
        identifier: row.identifier,
        title: row.title,
      }));
    },

    async listReviewerAgents(companyId, roles) {
      if (roles.length === 0) return [];
      const rows = await db
        .select({ id: agents.id, role: agents.role, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.role, [...roles])));
      return rows.filter((row) => isAgentStatusInvokable(row.status)).map((row) => ({ id: row.id, role: row.role }));
    },

    async loadByAgent(companyId) {
      const rows = await db
        .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            isNull(issues.hiddenAt),
            sql`${issues.status} in ('in_progress', 'in_review')`,
            sql`${issues.assigneeAgentId} is not null`,
          ),
        )
        .groupBy(issues.assigneeAgentId);
      const load = new Map<string, number>();
      for (const row of rows) if (row.agentId) load.set(row.agentId, row.count);
      return load;
    },

    async routingHistory(companyId, issueIds) {
      const history = new Map<string, RoutingHistory>();
      if (issueIds.length === 0) return history;
      const rows = await db
        .select({
          entityId: activityLog.entityId,
          createdAt: activityLog.createdAt,
          reviewerAgentId: sql<string | null>`${activityLog.details} ->> 'reviewerAgentId'`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, [...issueIds]),
            inArray(activityLog.action, [REVIEW_ROUTING_ASSIGNED_ACTION, REVIEW_ROUTING_REASSIGNED_ACTION]),
          ),
        )
        .orderBy(desc(activityLog.createdAt));
      // Newest first: the first row per task is the last routing event.
      for (const row of rows) {
        const entry = history.get(row.entityId) ?? { lastAt: row.createdAt, reviewerAgentIds: [] };
        if (row.reviewerAgentId) entry.reviewerAgentIds.unshift(row.reviewerAgentId);
        history.set(row.entityId, entry);
      }
      return history;
    },

    async applyPatch(input) {
      const issueService = await loadIssueService();
      const svc = issueService(db);
      try {
        return await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(issues)
            .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
            .for("update")
            .limit(1);
          if (!current) return null;
          const fresh = toRoutingIssue(current);
          if (!input.guard(fresh)) return null;
          const patch = input.build(fresh);
          if (!patch) return null;
          const applied = await svc.update(input.issueId, patch as Partial<typeof issues.$inferInsert>, tx);
          if (!applied) return null;
          return { executionState: (applied.executionState as Record<string, unknown> | null) ?? null };
        });
      } catch {
        // The issue service throws (not a falsy return) when the assignee is
        // locked or the transition is refused: this task is left to a person.
        return null;
      }
    },
  };
}
