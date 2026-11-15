// myrmidon(MONITOR-IDLE-LOOP, OPE-13141): database reads for the idle-monitor policy.

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  activityLog,
  documents,
  instanceSettings,
  issueComments,
  issueDocuments,
  issueWorkProducts,
  issues,
} from "@myrmidon/db";
import {
  DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT,
  MONITOR_OBSERVATION_ACTIONS,
  resolveMonitorUnchangedWakeLimit,
  type MonitorObservation,
} from "./policy.js";

/** Read with the pool `db`, never with an open transaction. */
export async function loadMonitorUnchangedWakeLimit(db: Db): Promise<number> {
  try {
    const [row] = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .limit(1);
    return resolveMonitorUnchangedWakeLimit(row?.general ?? {});
  } catch {
    return DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function pullRequestFact(product: { status: string; reviewState: string | null; metadata: unknown }) {
  const metadata = asRecord(product.metadata) ?? {};
  const completed = asRecord(metadata.lastCompletedCi);
  const active = asRecord(metadata.activeCi);
  return {
    status: product.status,
    reviewState: product.reviewState ?? null,
    state: text(metadata.state),
    head: text(metadata.headSha) ?? text(metadata.sha) ?? text(metadata.head_sha) ?? text(metadata.headRefOid),
    mergeable: text(metadata.mergeable),
    completedHead: text(completed?.headSha),
    completedConclusion: text(completed?.conclusion),
    activeStatus: text(active?.status),
    activeHead: text(active?.headSha),
  };
}

/**
 * A stable fingerprint of what a task that waits for its subtasks depends on:
 * the task and subtask statuses and assignees, the pull requests of all of them
 * (state, review, head, CI marks), the comments written by anyone but the owner
 * and the documents last edited by anyone but the owner. The owner's own
 * writes are not news to the owner. Returns null for a task without subtasks:
 * there the monitor waits for something outside the board and is left alone.
 */
export async function readIssueMonitorSnapshotHash(
  db: Db,
  input: { companyId: string; issueId: string; ownerAgentId: string },
): Promise<string | null> {
  const children = await db
    .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, input.issueId)));
  if (children.length === 0) return null;
  const own = await db
    .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const ids = [input.issueId, ...children.map((child) => child.id)];

  const products = await db
    .select({
      issueId: issueWorkProducts.issueId,
      status: issueWorkProducts.status,
      reviewState: issueWorkProducts.reviewState,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, input.companyId),
        inArray(issueWorkProducts.issueId, ids),
        eq(issueWorkProducts.type, "pull_request"),
      ),
    );

  const comments = await db
    .select({
      issueId: issueComments.issueId,
      count: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${issueComments.createdAt})::text`,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        inArray(issueComments.issueId, ids),
        isNull(issueComments.deletedAt),
        or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, input.ownerAgentId)),
      ),
    )
    .groupBy(issueComments.issueId);

  const docs = await db
    .select({
      issueId: issueDocuments.issueId,
      key: issueDocuments.key,
      revision: documents.latestRevisionNumber,
      updatedByAgentId: documents.updatedByAgentId,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(eq(issueDocuments.companyId, input.companyId), inArray(issueDocuments.issueId, ids)));

  const snapshot = {
    own: own ? [own.status, own.assigneeAgentId] : null,
    children: children.map((child) => [child.id, child.status, child.assigneeAgentId]).sort(),
    pullRequests: products
      .map((product) => [product.issueId, pullRequestFact(product)])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    comments: comments.map((row) => [row.issueId, row.count, row.last]).sort(),
    documents: docs
      .filter((doc) => doc.updatedByAgentId !== input.ownerAgentId)
      .map((doc) => [doc.issueId, doc.key, doc.revision])
      .sort(),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** The latest wake or silent deferral of the task's monitor that recorded a snapshot. */
export async function readLastMonitorObservation(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<MonitorObservation | null> {
  const row = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        inArray(activityLog.action, [...MONITOR_OBSERVATION_ACTIONS]),
        sql`${activityLog.details} ->> 'snapshotHash' is not null`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const details = asRecord(row?.details);
  const snapshotHash = typeof details?.snapshotHash === "string" ? details.snapshotHash : null;
  if (!snapshotHash) return null;
  const count = typeof details?.unchangedCount === "number" ? details.unchangedCount : 0;
  return { snapshotHash, unchangedCount: Math.max(0, Math.trunc(count)) };
}
