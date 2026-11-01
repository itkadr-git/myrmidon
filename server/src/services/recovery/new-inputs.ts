import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import {
  issueComments,
  issueRelations,
  issues,
  issueWorkProducts,
} from "@myrmidon/db";

export interface IssueNewInputsOptions {
  companyId: string;
  issueId: string;
  since: Date;
  excludeRunId?: string | null;
}

/**
 * Checks whether an issue has received any new inputs since `since`:
 * - new comments (excluding comments created by `excludeRunId`)
 * - changes in blockers (issue_relations type 'blocks' or blockedTransitionAt)
 * - status change away from todo
 * - pull requests linked or updated
 *
 * Implements rule OPE-4519: recovery must not wake an executor repeatedly
 * if there are no new inputs since the prior run.
 */
export async function hasNewInputsSince(
  db: Db,
  input: IssueNewInputsOptions,
): Promise<boolean> {
  const { companyId, issueId, since, excludeRunId } = input;

  // 1. Comments: created after `since`, not authored by the excluded run itself
  const [comment] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        isNull(issueComments.deletedAt),
        gt(issueComments.createdAt, since),
        excludeRunId
          ? sql`(${issueComments.createdByRunId} is null or ${issueComments.createdByRunId} <> ${excludeRunId}::uuid)`
          : undefined,
      ),
    )
    .limit(1);
  if (comment) return true;

  // 2. Blockers: issue_relations with type 'blocks' pointing to this issue, created or updated after `since`
  const [relation] = await db
    .select({ issueId: issueRelations.issueId })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
        or(
          gt(issueRelations.createdAt, since),
          gt(issueRelations.updatedAt, since),
        ),
      ),
    )
    .limit(1);
  if (relation) return true;

  // 3. Status changes or blocked transitions
  const [issueRow] = await db
    .select({
      id: issues.id,
      status: issues.status,
      updatedAt: issues.updatedAt,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);

  if (issueRow) {
    if (issueRow.blockedTransitionAt && issueRow.blockedTransitionAt > since) {
      return true;
    }
    if (issueRow.status !== "todo" && issueRow.updatedAt > since) {
      return true;
    }
  }

  // 4. Pull Requests linked to the issue (created or updated after `since`)
  const [pr] = await db
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.issueId, issueId),
        eq(issueWorkProducts.type, "pull_request"),
        or(
          gt(issueWorkProducts.createdAt, since),
          gt(issueWorkProducts.updatedAt, since),
        ),
      ),
    )
    .limit(1);
  if (pr) return true;

  return false;
}
