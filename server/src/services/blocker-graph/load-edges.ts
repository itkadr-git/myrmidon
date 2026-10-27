import type { Db } from "@myrmidon/db";
import { issueRelations, issues } from "@myrmidon/db";
import { and, asc, eq, notInArray } from "drizzle-orm";

export const BLOCKED_GRAPH_QUERY_LIMIT = 1_000;

export interface BlockerGraphEdge {
  blockedId: string;
  blockerId: string;
  blockerStatus: string;
}

export interface BlockedGraphIssue {
  id: string;
  status: string;
  blockerMetadata: typeof issues.$inferSelect.blockerMetadata;
  blockedSince: Date | null;
}

/** Independent ID-ordered prefixes; truncation means callers must not infer full-company totals. */
export async function loadBlockedGraph(db: Db, companyId: string): Promise<{
  edges: BlockerGraphEdge[];
  blockedIssues: BlockedGraphIssue[];
  truncated: { edges: boolean; blockedIssues: boolean };
}> {
  const edgeRows = await db
    .select({
      blockedId: issueRelations.relatedIssueId,
      blockerId: issueRelations.issueId,
      blockerStatus: issues.status,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(and(
      eq(issueRelations.companyId, companyId),
      eq(issueRelations.type, "blocks"),
      eq(issues.companyId, companyId),
      notInArray(issues.status, ["done", "cancelled"]),
    ))
    .orderBy(asc(issueRelations.relatedIssueId), asc(issueRelations.issueId))
    .limit(BLOCKED_GRAPH_QUERY_LIMIT + 1);

  const blockedRows = await db
    .select({
      id: issues.id,
      status: issues.status,
      blockerMetadata: issues.blockerMetadata,
      blockedSince: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked")))
    .orderBy(asc(issues.id))
    .limit(BLOCKED_GRAPH_QUERY_LIMIT + 1);

  return {
    edges: edgeRows.slice(0, BLOCKED_GRAPH_QUERY_LIMIT),
    blockedIssues: blockedRows.slice(0, BLOCKED_GRAPH_QUERY_LIMIT),
    truncated: {
      edges: edgeRows.length > BLOCKED_GRAPH_QUERY_LIMIT,
      blockedIssues: blockedRows.length > BLOCKED_GRAPH_QUERY_LIMIT,
    },
  };
}