import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { documentRevisions, documents, issueDocuments, issues } from "@myrmidon/db";

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
     * trust issue identity and document revision together.
     *
     * myrmidon(OPE-15145): every hop is tenant-bound to the issue's own
     * company_id. issue_documents and documents have independent foreign
     * keys and no composite tenant constraint, so a link row owned by
     * company A can point at a document owned by company B; a plain
     * documents.id join would serve B's body under A's issue. The document
     * side is returned only when ALL of these hold on the same snapshot:
     *   - the link row matches issue_id, company_id and the fixed key;
     *   - the document matches id AND company_id;
     *   - the published revision matches latest_revision_id, document_id
     *     AND company_id, and its body equals documents.latest_body
     *     (a row rewritten outside the revision log binds to nothing).
     * Otherwise the document fails closed to null — never a foreign or
     * mixed body. A missing issue yields null.
     */
    read: async (issueId: string): Promise<IssueAcceptanceSnapshot | null> => {
      const rows = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          documentId: documents.id,
          latestRevisionId: documents.latestRevisionId,
          body: documentRevisions.body,
        })
        .from(issues)
        .leftJoin(
          issueDocuments,
          and(
            eq(issueDocuments.issueId, issues.id),
            eq(issueDocuments.companyId, issues.companyId),
            eq(issueDocuments.key, "acceptance-scenarios"),
          ),
        )
        .leftJoin(
          documents,
          and(
            eq(documents.id, issueDocuments.documentId),
            eq(documents.companyId, issues.companyId),
          ),
        )
        .leftJoin(
          documentRevisions,
          and(
            eq(documentRevisions.id, documents.latestRevisionId),
            eq(documentRevisions.documentId, documents.id),
            eq(documentRevisions.companyId, issues.companyId),
            eq(documentRevisions.body, documents.latestBody),
          ),
        )
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
        // A document is present only when every tenant-bound hop produced a
        // complete, mutually consistent row; anything else fails closed.
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
