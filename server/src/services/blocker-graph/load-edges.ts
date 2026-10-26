import type { Db } from "@myrmidon/db";
import { issueRelations, issues } from "@myrmidon/db";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

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

/** Load one bounded company snapshot; relation rows and issue metadata are batch reads. */
export async function loadBlockedGraph(db: Db, companyId: string): Promise<{
  edges: BlockerGraphEdge[];
  blockedIssues: BlockedGraphIssue[];
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
    .limit(BLOCKED_GRAPH_QUERY_LIMIT);

  const blockedIds = [...new Set(edgeRows.map((row) => row.blockedId))];
  const blockedRows = blockedIds.length === 0 ? [] : await db
    .select({
      id: issues.id,
      status: issues.status,
      blockerMetadata: issues.blockerMetadata,
      blockedSince: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockedIds)))
    .orderBy(asc(issues.id))
    .limit(BLOCKED_GRAPH_QUERY_LIMIT);

  return { edges: edgeRows, blockedIssues: blockedRows };
}