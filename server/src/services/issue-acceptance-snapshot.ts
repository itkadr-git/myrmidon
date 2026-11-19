import { and, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { documentRevisions, documents, issueAcceptanceEpochs, issueDocuments, issues } from "@myrmidon/db";
import { isUuidLike } from "@myrmidon/shared";

export interface IssueAcceptanceSnapshotIssue {
  id: string;
  identifier: string | null;
  companyId: string;
  /**
   * Monotonic per-issue mutation version bumped by DB triggers (migration
   * 0489). A decimal string: bigint generations beyond 2^53 must stay exact
   * for the reader's pin comparison.
   */
  version: string;
}

export interface IssueAcceptanceSnapshotDocument {
  id: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number | null;
  body: string;
}

export interface IssueAcceptanceSnapshot {
  issue: IssueAcceptanceSnapshotIssue;
  document: IssueAcceptanceSnapshotDocument | null;
}

export function issueAcceptanceSnapshotService(db: Db) {
  return {
    /**
     * Read the minimal acceptance snapshot for one issue, addressed by
     * canonical identifier (OPE-123) or UUID.
     *
     * myrmidon(OPE-15134): this is deliberately ONE joined SELECT statement.
     * Postgres serves a single statement from a single MVCC snapshot, so the
     * issue row and the acceptance document row cannot come from different
     * moments — the property two independent REST reads cannot provide, and
     * the property the acceptance-reader gateway needs before a CI gate may
     * trust issue identity and document revision together. The issue itself
     * is resolved inside the same statement (identifier or UUID), so the
     * route authorizes exactly the row it serves — no read-before-auth gap.
     *
     * myrmidon(OPE-15145): every hop is tenant-bound to the issue's own
     * company_id. issue_documents and documents have independent foreign
     * keys. The database also enforces the acceptance binding on writes;
     * these joins independently fail closed on inconsistent stored data.
     * A plain documents.id join could otherwise serve a foreign body. The document
     * side is returned only when ALL of these hold on the same snapshot:
     *   - the link row matches issue_id, company_id and the fixed key;
     *   - the document matches id AND company_id;
     *   - the published revision matches latest_revision_id, document_id
     *     AND company_id, and its body equals documents.latest_body
     *     (a row rewritten outside the revision log binds to nothing).
     * Otherwise the document fails closed to null — never a foreign or
     * mixed body. A missing issue yields null.
     *
     * The issue epoch, not revision-number equality alone, detects relevant
     * intervening writes, including ABA. Verification is a point-in-time
     * check, not an atomic publication or a run identity binding; see the
     * acceptance-reader README for the remaining security prerequisites.
     */
    read: async (issueRef: string, companyId?: string): Promise<IssueAcceptanceSnapshot | null> => {
      const ref = issueRef.trim();
      if (!ref) return null;
      const identity = isUuidLike(ref)
        ? eq(issues.id, ref)
        : eq(issues.identifier, ref.toUpperCase());
      const rows = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          issueEpoch: issueAcceptanceEpochs.epoch,
          documentId: documents.id,
          latestRevisionId: documents.latestRevisionId,
          latestRevisionNumber: documents.latestRevisionNumber,
          body: documentRevisions.body,
        })
        .from(issues)
        .leftJoin(
          issueAcceptanceEpochs,
          eq(issueAcceptanceEpochs.issueId, issues.id),
        )
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
        .where(companyId ? and(identity, eq(issues.companyId, companyId)) : identity)
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const generation = row.latestRevisionNumber;
      return {
        issue: {
          id: row.issueId,
          identifier: row.identifier,
          companyId: row.companyId,
          version: String(row.issueEpoch ?? 0),
        },
        // A document is present only when every tenant-bound hop produced a
        // complete, mutually consistent row — including a valid monotonic
        // generation; anything else fails closed.
        document:
          row.documentId &&
          row.body !== null &&
          typeof generation === "number" &&
          Number.isInteger(generation) &&
          generation > 0
            ? {
                id: row.documentId,
                latestRevisionId: row.latestRevisionId,
                latestRevisionNumber: generation,
                body: row.body,
              }
            : null,
      };
    },
  };
}
