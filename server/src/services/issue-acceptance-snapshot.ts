import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { documents, issueDocuments, issues } from "@myrmidon/db";

export interface IssueAcceptanceSnapshotIssue {
  id: string;
  identifier: string | null;
  companyId: string;
}

export interface IssueAcceptanceSnapshotDocument {
  id: string;
  latestRevisionId: string | null;
  body: string;
}

export interface IssueAcceptanceSnapshot {
  issue: IssueAcceptanceSnapshotIssue;
  document: IssueAcceptanceSnapshotDocument | null;
}

export function issueAcceptanceSnapshotService(db: Db) {
  return {
    /**
     * Read the minimal acceptance snapshot for one issue.
     *
     * myrmidon(OPE-15134): this is deliberately ONE joined SELECT statement.
     * Postgres serves a single statement from a single MVCC snapshot, so the
     * issue row and the acceptance document row cannot come from different
     * moments — the property two independent REST reads cannot provide, and
     * the property the acceptance-reader gateway needs before a CI gate may
     * trust issue identity and document revision together. A missing document
     * yields `document: null`; a missing issue yields null.
     */
    read: async (issueId: string): Promise<IssueAcceptanceSnapshot | null> => {
      const rows = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          documentId: documents.id,
          latestRevisionId: documents.latestRevisionId,
          body: documents.latestBody,
        })
        .from(issues)
        .leftJoin(
          issueDocuments,
          and(
            eq(issueDocuments.issueId, issues.id),
            // Defense in depth: the link row must belong to the same company
            // as the issue it hangs off, not only to the same issue id.
            eq(issueDocuments.companyId, issues.companyId),
            eq(issueDocuments.key, "acceptance-scenarios"),
          ),
        )
        .leftJoin(documents, eq(documents.id, issueDocuments.documentId))
        .where(eq(issues.id, issueId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        issue: {
          id: row.issueId,
          identifier: row.identifier,
          companyId: row.companyId,
        },
        // A document is present only when the joins produced a complete row;
        // anything else fails closed to "no document" rather than projecting
        // a null body.
        document:
          row.documentId && row.body !== null
            ? {
                id: row.documentId,
                latestRevisionId: row.latestRevisionId,
                body: row.body,
              }
            : null,
      };
    },
  };
}
