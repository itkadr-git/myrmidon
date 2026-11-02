import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { issueRelations, issueThreadInteractions, issues, type Db } from "../../../packages/db/src/index.js";

/**
 * List blocked issues with no pending interaction, child, or blocker metadata.
 * Existing blocker relations are retained as classification evidence so legacy
 * dependencies can be migrated to typed metadata instead of being omitted.
 */
export async function listLegacyBlocked(db: Db) {
  const blockingIssues = alias(issues, "legacy_blocking_issue");
  const childIssues = alias(issues, "legacy_child_issue");

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);

    const openBlocker = tx
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .innerJoin(blockingIssues, eq(blockingIssues.id, issueRelations.issueId))
      .where(
        and(
          eq(issueRelations.companyId, issues.companyId),
          eq(blockingIssues.companyId, issues.companyId),
          eq(issueRelations.relatedIssueId, issues.id),
          eq(issueRelations.type, "blocks"),
        ),
      );
    const pendingInteraction = tx
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, issues.companyId),
          eq(issueThreadInteractions.issueId, issues.id),
          eq(issueThreadInteractions.status, "pending"),
        ),
      );
    const childIssue = tx
      .select({ id: childIssues.id })
      .from(childIssues)
      .where(
        and(eq(childIssues.parentId, issues.id), eq(childIssues.companyId, issues.companyId)),
      );

    return tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.status, "blocked"),
          isNull(issues.blockerMetadata),
          notExists(openBlocker),
          notExists(pendingInteraction),
          notExists(childIssue),
        ),
      );
  });
}
