// myrmidon(REVIEW-ROUTING): the database half of the sweep.
//
// Reads are plain selects; the one write path is `applyPatch`, which re-reads
// the issue under a row lock, lets the caller re-check its premise against the
// FRESH row, and only then applies the patch through the ordinary issue
// service (never a hand-rolled UPDATE). A racing writer (a human assigning a
// reviewer, another sweep process) therefore makes the guard fail instead of
// being overwritten.
//
// The PR lane (1.6.5) adds: candidate discovery (externalObjects rows, the
// work-product repo registry, open pr-routing tasks), and `createPrRoutingTask`
// — task creation through the ordinary issue service with the work-product
// coverage re-checked inside the same guarded path, so two racing passes never
// create two tasks for one head.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  externalObjects,
  heartbeatRuns,
  issues,
  issueWorkProducts,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import {
  REVIEW_ROUTING_ASSIGNED_ACTION,
  REVIEW_ROUTING_REASSIGNED_ACTION,
  REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY,
  REVIEW_ROUTING_PR_KIND_METADATA_KEY,
} from "@paperclipai/shared";
import type { PrRoutedTask } from "./pr-policy.js";
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

  // --- PR lane (1.6.5) -------------------------------------------------------

  /** Open GitHub pull requests the company has rows for (webhook-fed). */
  listPrCandidates(companyId: string, limit: number): Promise<PrCandidateRow[]>;
  /** Distinct "owner/repo" the instance has ever seen PRs of (rows + work products). */
  listKnownPrRepositories(companyId: string): Promise<string[]>;
  /** Open board tasks this lane created, with their recorded heads. */
  listOpenPrRoutingTasks(companyId: string): Promise<PrRoutedTask[]>;
  /** Agents' OPEN pr-routing task count, per kind (this lane's own load). */
  openPrTaskLoadByAgent(companyId: string, kind: PrRoutingKind): Promise<Map<string, number>>;
  /** Agents linked to a GitHub login through their recent runs' identity contexts. */
  findAgentIdsByGitHubLogin(companyId: string, login: string): Promise<string[]>;
  /**
   * Guarded creation: re-checks the work-product coverage under an advisory
   * lock in the same transaction that creates the task and attaches its
   * pull_request work product, so two racing passes never create two tasks.
   */
  createPrRoutingTask(input: CreatePrRoutingTaskInput): Promise<CreatePrRoutingTaskResult>;
  /** Cancels a superseded pr-routing task through the ordinary issue update. */
  cancelPrRoutingTask(input: { issueId: string; companyId: string }): Promise<boolean>;
}

/** Service layer loaded lazily, for the same startup-graph reason as the stale-block sweep. */
async function loadIssueService() {
  const module = await import("../../services/issues.js");
  return module.issueService;
}

/** The PR lane's own kind: a review task or a merge-steward task. */
export type PrRoutingKind = "review" | "merge";

/** One open pull request seen through the company's externalObjects rows. */
export interface PrCandidateRow {
  repository: string;
  number: number;
  /** The head sha the webhook last reported (nullable — re-resolved against GitHub). */
  headSha: string | null;
  title: string | null;
  url: string | null;
  authorLogin: string | null;
  baseRef: string | null;
  draft: boolean;
}

export interface CreatePrRoutingTaskInput {
  companyId: string;
  repository: string;
  number: number;
  kind: PrRoutingKind;
  headSha: string;
  title: string;
  description: string;
  /** Status the review-stage transition produced for the fresh task (mirrors the task lane). */
  status: string;
  assigneeAgentId: string;
  /** The review-stage policy patch the lane wants on the fresh task. */
  executionPolicy: unknown;
  executionState: unknown;
  /** PR coordinates persisted on the pull_request work product. */
  prUrl: string | null;
  prTitle: string | null;
  authorLogin: string | null;
  baseRef: string | null;
  draft: boolean;
}

export interface CreatePrRoutingTaskResult {
  /** null when the coverage re-check found the head already covered (no task created). */
  issueId: string | null;
  deduplicated: boolean;
}

/** `owner/repo` from the metadata GitHub rows and work products carry. */
function repositoryFromParts(owner: unknown, repo: unknown): string | null {
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  if (owner.length === 0 || repo.length === 0) return null;
  return `${owner}/${repo}`;
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

    // --- PR lane (1.6.5) -----------------------------------------------------

    async listPrCandidates(companyId, limit) {
      const rows = await db
        .select()
        .from(externalObjects)
        .where(
          and(
            eq(externalObjects.companyId, companyId),
            eq(externalObjects.providerKey, "github"),
            eq(externalObjects.objectType, "pull_request"),
            eq(externalObjects.isTerminal, false),
          ),
        )
        .orderBy(desc(externalObjects.updatedAt))
        .limit(limit);
      const out: PrCandidateRow[] = [];
      for (const row of rows) {
        const data = (row.data ?? {}) as Record<string, unknown>;
        const repository = repositoryFromParts(data.owner, data.repo);
        const number = typeof data.number === "number" && Number.isSafeInteger(data.number) ? data.number : null;
        if (!repository || number === null) continue;
        out.push({
          repository,
          number,
          headSha: typeof data.headSha === "string" ? data.headSha : null,
          title: row.displayTitle,
          url: typeof data.url === "string" ? data.url : row.sanitizedCanonicalUrl ?? null,
          authorLogin: typeof data.authorLogin === "string" ? data.authorLogin : null,
          baseRef: typeof data.baseRef === "string" ? data.baseRef : null,
          draft: row.statusKey === "draft" || data.draft === true,
        });
      }
      return out;
    },

    async listKnownPrRepositories(companyId) {
      const repos = new Set<string>();
      const rows = await db
        .select({ data: externalObjects.data })
        .from(externalObjects)
        .where(
          and(
            eq(externalObjects.companyId, companyId),
            eq(externalObjects.providerKey, "github"),
            eq(externalObjects.objectType, "pull_request"),
          ),
        );
      for (const row of rows) {
        const repository = repositoryFromParts(row.data?.owner, row.data?.repo);
        if (repository) repos.add(repository);
      }
      const products = await db
        .select({ metadata: issueWorkProducts.metadata })
        .from(issueWorkProducts)
        .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.type, "pull_request")));
      for (const product of products) {
        const metadata = product.metadata;
        if (typeof metadata?.repo === "string" && metadata.repo.includes("/")) repos.add(metadata.repo);
        else {
          const repository = repositoryFromParts(metadata?.owner, metadata?.repo);
          if (repository) repos.add(repository);
        }
      }
      return [...repos].sort();
    },

    async listOpenPrRoutingTasks(companyId) {
      const rows = await db
        .select({
          issueId: issues.id,
          metadata: issueWorkProducts.metadata,
        })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.type, "pull_request"),
            sql`${issueWorkProducts.metadata} ->> ${REVIEW_ROUTING_PR_KIND_METADATA_KEY} IN ('review', 'merge')`,
            sql`${issues.status} NOT IN ('done', 'cancelled')`,
            isNull(issues.hiddenAt),
          ),
        );
      const out: PrRoutedTask[] = [];
      for (const row of rows) {
        const metadata = row.metadata;
        if (!metadata) continue;
        const kind = metadata[REVIEW_ROUTING_PR_KIND_METADATA_KEY];
        if (kind !== "review" && kind !== "merge") continue;
        const repository =
          typeof metadata.repo === "string" ? metadata.repo : repositoryFromParts(metadata.owner, metadata.repo);
        const number = typeof metadata.number === "number" && Number.isSafeInteger(metadata.number) ? metadata.number : null;
        if (!repository || number === null) continue;
        const headSha = typeof metadata[REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY] === "string"
          ? (metadata[REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY] as string)
          : null;
        out.push({ issueId: row.issueId, repository, number, kind, headSha });
      }
      return out;
    },

    async openPrTaskLoadByAgent(companyId, kind) {
      const rows = await db
        .select({ agentId: issues.assigneeAgentId, count: sql<number>`count(*)::int` })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.type, "pull_request"),
            sql`${issueWorkProducts.metadata} ->> ${REVIEW_ROUTING_PR_KIND_METADATA_KEY} = ${kind}`,
            sql`${issues.status} NOT IN ('done', 'cancelled')`,
            isNull(issues.hiddenAt),
            sql`${issues.assigneeAgentId} is not null`,
          ),
        )
        .groupBy(issues.assigneeAgentId);
      const load = new Map<string, number>();
      for (const row of rows) if (row.agentId) load.set(row.agentId, row.count);
      return load;
    },

    async findAgentIdsByGitHubLogin(companyId, login) {
      // The linkage this instance keeps: a run's identity context records the
      // GitHub login that issued its pushes. The most recent runs answer first
      // so a freshly linked agent wins over an archived mapping.
      const rows = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(runIdentityContexts)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, runIdentityContexts.runId))
        .where(
          and(
            eq(runIdentityContexts.companyId, companyId),
            sql`lower(${runIdentityContexts.github} ->> 'login') = lower(${login})`,
          ),
        )
        .orderBy(desc(runIdentityContexts.createdAt))
        .limit(5);
      return [...new Set(rows.map((row) => row.agentId))];
    },

    async createPrRoutingTask(input) {
      const issueService = await loadIssueService();
      const coverageKey = `review-pr:${input.repository}#${input.number}:${input.kind}:${input.headSha}`;
      try {
        return await db.transaction(async (tx) => {
          // Serialize creation per (PR, kind, head): the advisory lock is held
          // for the transaction, so the coverage re-check below is race-free
          // against a second pass running the same code.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${coverageKey}, 0))`);
          const [covered] = await tx
            .select({ id: issues.id })
            .from(issueWorkProducts)
            .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
            .where(
              and(
                eq(issueWorkProducts.companyId, input.companyId),
                eq(issueWorkProducts.type, "pull_request"),
                sql`${issueWorkProducts.metadata} ->> 'repo' = ${input.repository}`,
                sql`${issueWorkProducts.metadata} ->> ${REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY} = ${input.headSha}`,
                sql`${issueWorkProducts.metadata} ->> ${REVIEW_ROUTING_PR_KIND_METADATA_KEY} = ${input.kind}`,
                sql`${issues.status} NOT IN ('done', 'cancelled')`,
                isNull(issues.hiddenAt),
              ),
            )
            .limit(1);
          if (covered) return { issueId: covered.id, deduplicated: true };

          const svc = issueService(tx as unknown as Db);
          const created = await svc.create(
            input.companyId,
            {
              title: input.title,
              description: input.description,
              status: input.status,
              priority: "high",
              assigneeAgentId: input.assigneeAgentId,
              createdByAgentId: null,
              createdByUserId: null,
              executionPolicy: input.executionPolicy as never,
              executionState: input.executionState as never,
              billingCode: "REVIEW-ROUTING",
              idempotencyKey: coverageKey.slice(0, 200),
            } as never,
            tx as unknown as Db,
          );
          if (!created) return { issueId: null, deduplicated: false };
          const { workProductService } = await import("../../services/work-products.js");
          await workProductService(tx as unknown as Db).createForIssue(created.id, input.companyId, {
            type: "pull_request",
            provider: "github",
            externalId: `${input.repository}#pull/${input.number}`,
            title: input.prTitle ?? `${input.repository}#${input.number}`,
            url: input.prUrl,
            status: "open",
            reviewState: "none",
            isPrimary: true,
            healthStatus: "unknown",
            metadata: {
              repo: input.repository,
              number: input.number,
              state: "open",
              draft: input.draft,
              ...(input.baseRef ? { baseRef: input.baseRef } : {}),
              ...(input.authorLogin ? { authorLogin: input.authorLogin } : {}),
              [REVIEW_ROUTING_PR_HEAD_SHA_METADATA_KEY]: input.headSha,
              [REVIEW_ROUTING_PR_KIND_METADATA_KEY]: input.kind,
            },
          });
          return { issueId: created.id, deduplicated: false };
        });
      } catch {
        // A refused create (locked agent, invalid transition) is not a crash
        // condition: the PR is simply retried on the next pass.
        return { issueId: null, deduplicated: false };
      }
    },

    async cancelPrRoutingTask({ issueId, companyId }) {
      const issueService = await loadIssueService();
      const svc = issueService(db);
      try {
        return await db.transaction(async (tx) => {
          const [current] = await tx
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
            .for("update")
            .limit(1);
          if (!current || current.status === "done" || current.status === "cancelled") return false;
          const applied = await svc.update(issueId, { status: "cancelled" } as Partial<typeof issues.$inferInsert>, tx);
          return Boolean(applied);
        });
      } catch {
        return false;
      }
    },
  };
}
