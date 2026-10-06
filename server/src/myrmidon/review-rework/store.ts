// server/src/myrmidon/review-rework/store.ts
//
// myrmidon(REVIEW-REWORK): the database half of the review-return loop.
//
// Reads are plain selects; every write goes through the ordinary issue service
// under a row lock and a status guard, so the activity log, the
// blocked-transition bookkeeping, the dependency wakes and the disposition
// rules behave exactly as when an operator makes the same move by hand (the
// rule the review routing store follows).
//
// The candidate set: tasks in a review shape (todo / in_review / blocked) that
// either already have a rework child, carry a verdict marker in a comment, or
// hold a pull_request work product. That EXISTS filter is the cheap gate; the
// expensive per-task reads (comments, PR coordinates) happen only for
// candidates the sweep actually processes.

import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  companies,
  issueComments,
  issueWorkProducts,
  issues,
  type Db,
} from "@paperclipai/db";
import { REVIEW_REWORK_ORIGIN_KIND, isAgentStatusInvokable } from "@paperclipai/shared";
import { decodeReworkFingerprint } from "./domain.js";
import type { ReviewReworkChildFacts, ReviewReworkTaskFacts } from "./domain.js";

/** A review candidate plus the PR coordinates its own work products carry. */
export interface ReworkCandidateRow {
  task: ReviewReworkTaskFacts;
  /** Title + description text, for PR-reference extraction (comments are read separately). */
  textParts: string[];
  /** The task's pull_request work products (non-archived). */
  products: Array<{ repo: string; number: number; status: string }>;
}

export interface CreateReworkTaskInput {
  companyId: string;
  title: string;
  description: string;
  assigneeAgentId: string | null;
  priority: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  parentId: string;
  originId: string;
  originFingerprint: string;
  idempotencyKey: string;
}

export interface ReviewReworkStore {
  listActiveCompanyIds(): Promise<string[]>;
  listCandidateTasks(companyId: string, limit: number): Promise<ReworkCandidateRow[]>;
  listComments(issueId: string): Promise<Array<{ id: string; body: string; createdAt: Date }>>;
  findReworkChild(companyId: string, reviewIssueId: string): Promise<ReviewReworkChildFacts | null>;
  /** The assignee of another task whose work product is this PR (the delivering task). */
  deliveringTaskAssignee(
    companyId: string,
    pr: { repo: string; number: number },
    excludeIssueId: string,
  ): Promise<string | null>;
  invokableAgentIds(companyId: string, agentIds: readonly string[]): Promise<Set<string>>;
  createReworkTask(input: CreateReworkTaskInput): Promise<{ id: string; identifier: string | null } | null>;
  reopenReworkTask(input: {
    issueId: string;
    companyId: string;
    comment: string;
    originFingerprint: string;
  }): Promise<boolean>;
  stampReworkFingerprint(input: {
    issueId: string;
    companyId: string;
    originFingerprint: string;
  }): Promise<boolean>;
  blockReviewTask(input: {
    issueId: string;
    companyId: string;
    expectStatus: string;
    reworkIssueId: string;
    comment: string;
  }): Promise<boolean>;
  unblockReviewTask(input: {
    issueId: string;
    companyId: string;
    reworkIssueId: string;
    comment: string;
  }): Promise<boolean>;
  closeReviewTask(input: {
    issueId: string;
    companyId: string;
    expectStatus: string;
    comment: string;
  }): Promise<boolean>;
}

function taskFacts(row: typeof issues.$inferSelect): ReviewReworkTaskFacts {
  const executionState =
    row.executionState && typeof row.executionState === "object" && !Array.isArray(row.executionState)
      ? (row.executionState as Record<string, unknown>)
      : null;
  const returnParticipant = executionState?.returnAssignee as
    | { type?: unknown; agentId?: unknown }
    | null
    | undefined;
  return {
    id: row.id,
    companyId: row.companyId,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    projectId: row.projectId,
    goalId: row.goalId,
    billingCode: row.billingCode,
    priority: row.priority,
    returnAssigneeAgentId:
      returnParticipant
      && returnParticipant.type === "agent"
      && typeof returnParticipant.agentId === "string"
        ? returnParticipant.agentId
        : null,
  };
}

function productCoordinates(metadata: unknown, url: string | null): { repo: string; number: number } | null {
  const record = (metadata ?? {}) as { repo?: unknown; number?: unknown };
  if (typeof record.repo === "string" && record.repo.length > 0
    && typeof record.number === "number" && Number.isSafeInteger(record.number) && record.number > 0) {
    return { repo: record.repo.toLowerCase(), number: record.number };
  }
  if (url) {
    const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)/i.exec(url);
    if (match) return { repo: `${match[1]}/${match[2]}`.toLowerCase(), number: Number(match[3]) };
  }
  return null;
}

/** Service layer loaded lazily (the startup-graph rule task-pr-sync's sweep follows). */
let servicesPromise: Promise<{
  issueService: typeof import("../../services/issues.js").issueService;
}> | null = null;

function loadIssueService() {
  servicesPromise ??= import("../../services/issues.js").then((module) => ({
    issueService: module.issueService,
  }));
  return servicesPromise;
}

// The comment body gate the candidate filter uses: any verdict word. A cheap
// ILIKE over the issue's own comments (indexed by issue id) — the parser does
// the real matching; the Cyrillic spelling the reviewer roles also write is
// covered so a return expressed as `ВЕРДИКТ #484: RETURN` still opens the loop.
const VERDICT_COMMENT_SQL = sql`(lower(${issueComments.body}) like '%verdict%' or lower(${issueComments.body}) like '%вердикт%')`;

export function createPgReviewReworkStore(db: Db): ReviewReworkStore {
  async function applyGuardedPatch(
    issueId: string,
    companyId: string,
    guard: (current: typeof issues.$inferSelect) => boolean,
    build: () => Record<string, unknown>,
    comment?: string,
  ): Promise<boolean> {
    const services = await loadIssueService();
    try {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const [current] = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
          .limit(1)
          .for("update");
        if (!current || !guard(current)) return false;
        const svc = services.issueService(txDb);
        const updated = await svc.update(issueId, build() as never, tx);
        if (!updated) return false;
        if (comment) {
          await svc.addComment(issueId, comment, {}, { authorType: "system" }, tx);
        }
        return true;
      });
    } catch {
      // The issue service throws when the transition is refused (a locked
      // assignee, a guard): leave the task to the next pass or to a person.
      return false;
    }
  }

  return {
    async listActiveCompanyIds() {
      const rows = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, "active"));
      return rows.map((row) => row.id);
    },

    async listCandidateTasks(companyId, limit) {
      const childExists = sql`exists (
        select 1 from ${issues} child
        where child.parent_id = ${issues.id}
          and child.origin_kind = ${REVIEW_REWORK_ORIGIN_KIND}
      )`;
      const verdictExists = sql`exists (
        select 1 from ${issueComments}
        where ${issueComments.issueId} = ${issues.id}
          and ${issueComments.deletedAt} is null
          and ${VERDICT_COMMENT_SQL}
      )`;
      const productExists = sql`exists (
        select 1 from ${issueWorkProducts}
        where ${issueWorkProducts.issueId} = ${issues.id}
          and ${issueWorkProducts.type} = 'pull_request'
          and ${issueWorkProducts.status} <> 'archived'
      )`;
      const rows = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            sql`${issues.status} in ('backlog', 'todo', 'in_review', 'blocked')`,
            isNull(issues.hiddenAt),
            isNull(issues.conversationAgentId),
            or(childExists, verdictExists, productExists),
          ),
        )
        .orderBy(asc(issues.updatedAt), asc(issues.id))
        .limit(limit);

      const out: ReworkCandidateRow[] = [];
      for (const row of rows) {
        const products = await db
          .select({ metadata: issueWorkProducts.metadata, url: issueWorkProducts.url, status: issueWorkProducts.status })
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.issueId, row.id),
              eq(issueWorkProducts.type, "pull_request"),
              sql`${issueWorkProducts.status} <> 'archived'`,
            ),
          );
        out.push({
          task: taskFacts(row),
          textParts: [row.title, row.description ?? ""],
          products: products
            .map((product) => ({ ...productCoordinates(product.metadata, product.url), status: product.status }))
            .filter((entry): entry is { repo: string; number: number; status: string } => entry !== null),
        });
      }
      return out;
    },

    async listComments(issueId) {
      return db
        .select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
        .orderBy(asc(issueComments.createdAt));
    },

    async findReworkChild(companyId, reviewIssueId) {
      const rows = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.parentId, reviewIssueId),
            eq(issues.originKind, REVIEW_REWORK_ORIGIN_KIND),
          ),
        )
        .orderBy(desc(issues.createdAt))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const decoded = decodeReworkFingerprint(row.originFingerprint);
      return {
        id: row.id,
        identifier: row.identifier,
        status: row.status,
        assigneeAgentId: row.assigneeAgentId,
        prKey: decoded.prKey,
        baselineHeadSha: decoded.baselineHeadSha,
      };
    },

    async deliveringTaskAssignee(companyId, pr, excludeIssueId) {
      const rows = await db
        .select({ assigneeAgentId: issues.assigneeAgentId })
        .from(issueWorkProducts)
        .innerJoin(
          issues,
          and(eq(issues.id, issueWorkProducts.issueId), eq(issues.companyId, issueWorkProducts.companyId)),
        )
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.type, "pull_request"),
            sql`${issueWorkProducts.status} <> 'archived'`,
            sql`${issues.id} <> ${excludeIssueId}`,
            or(
              sql`lower(${issueWorkProducts.metadata} ->> 'repo') = ${pr.repo}
                  and cast(${issueWorkProducts.metadata} ->> 'number' as text) = ${String(pr.number)}`,
              sql`${issueWorkProducts.url} like ${"%/github.com/" + pr.repo + "/pull/" + pr.number}%`,
            ),
          ),
        )
        .limit(1);
      return rows[0]?.assigneeAgentId ?? null;
    },

    async invokableAgentIds(companyId, agentIds) {
      const unique = [...new Set(agentIds.filter(Boolean))];
      if (unique.length === 0) return new Set<string>();
      const { agents } = await import("@paperclipai/db");
      const rows = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, unique)));
      return new Set(rows.filter((row) => isAgentStatusInvokable(row.status)).map((row) => row.id));
    },

    async createReworkTask(input) {
      const services = await loadIssueService();
      const svc = services.issueService(db);
      try {
        const created = await svc.create(input.companyId, {
          title: input.title,
          description: input.description,
          status: "todo",
          assigneeAgentId: input.assigneeAgentId,
          priority: input.priority ?? "high",
          projectId: input.projectId,
          goalId: input.goalId,
          billingCode: input.billingCode,
          parentId: input.parentId,
          originKind: REVIEW_REWORK_ORIGIN_KIND,
          originId: input.originId,
          originFingerprint: input.originFingerprint,
          idempotencyKey: input.idempotencyKey,
        } as never);
        if (!created) return null;
        return { id: created.id, identifier: created.identifier };
      } catch {
        // A refused create (a guard or a dedup race) is retried by the next pass.
        return null;
      }
    },

    async reopenReworkTask(input) {
      return applyGuardedPatch(
        input.issueId,
        input.companyId,
        (current) =>
          current.originKind === REVIEW_REWORK_ORIGIN_KIND
          && (current.status === "done" || current.status === "cancelled"),
        () => ({ status: "todo", originFingerprint: input.originFingerprint }),
        input.comment,
      );
    },

    async stampReworkFingerprint(input) {
      return applyGuardedPatch(
        input.issueId,
        input.companyId,
        (current) => current.originKind === REVIEW_REWORK_ORIGIN_KIND,
        () => ({ originFingerprint: input.originFingerprint }),
      );
    },

    async blockReviewTask(input) {
      return applyGuardedPatch(
        input.issueId,
        input.companyId,
        (current) => current.status === input.expectStatus,
        () => ({
          status: "blocked",
          blockedByIssueIds: [input.reworkIssueId],
          unblockDescriptor: {
            owner: "board",
            action:
              "The reviewed pull request moved: the board lifts this block automatically when the PR " +
              `head changes (rework task ${input.reworkIssueId}).`,
            reasonRef: { kind: "issue", issueId: input.reworkIssueId },
          },
        }),
        input.comment,
      );
    },

    async unblockReviewTask(input) {
      // Keep blockers other than the rework task; read the set before the lock.
      const services = await loadIssueService();
      const svc = services.issueService(db);
      const readiness = await svc.getDependencyReadiness(input.issueId);
      const remaining = [...(readiness.blockerIssueIds ?? [])].filter((id) => id !== input.reworkIssueId);
      return applyGuardedPatch(
        input.issueId,
        input.companyId,
        (current) => current.status === "blocked",
        () => ({
          status: "todo",
          blockedByIssueIds: remaining,
          unblockDescriptor: null,
        }),
        input.comment,
      );
    },

    async closeReviewTask(input) {
      return applyGuardedPatch(
        input.issueId,
        input.companyId,
        (current) => current.status === input.expectStatus,
        () => ({ status: "done", executionState: null, executionPolicy: null }),
        input.comment,
      );
    },
  };
}
