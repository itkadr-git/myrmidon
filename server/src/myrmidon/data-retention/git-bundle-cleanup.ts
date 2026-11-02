import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { assets, issueAttachments, issues } from "@myrmidon/db";
import type { StorageService } from "../../storage/types.js";

/** Closed-task git bundles are registered with this immutable asset filename. */
export const GIT_BUNDLE_ATTACHMENT_FILENAME = "workspace.bundle";
export const CLOSED_TASK_GIT_BUNDLE_GRACE_DAYS = 2;

export interface GitBundleCleanupResult {
  deleted: number;
  failed: number;
}

export interface GitBundleCleanupDeps {
  db: Db;
  storage: StorageService;
  now?: () => Date;
}

/**
 * Delete storage-backed git bundle attachments after their issue has been
 * closed for the grace period. Storage is deleted first; a failed provider
 * operation leaves the database row for the next idempotent retry.
 */
export function createClosedTaskGitBundleCleanup(deps: GitBundleCleanupDeps) {
  const now = deps.now ?? (() => new Date());

  return async function cleanup(): Promise<GitBundleCleanupResult> {
    const cutoff = new Date(
      now().getTime() - CLOSED_TASK_GIT_BUNDLE_GRACE_DAYS * 24 * 60 * 60 * 1000,
    );
    const candidates = await deps.db
      .select({
        attachmentId: issueAttachments.id,
        companyId: issueAttachments.companyId,
        objectKey: assets.objectKey,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(
        and(
          inArray(issues.status, ["done", "cancelled"]),
          isNotNull(issues.completedAt),
          lte(issues.completedAt, cutoff),
          eq(assets.originalFilename, GIT_BUNDLE_ATTACHMENT_FILENAME),
          or(
            eq(assets.contentType, "application/octet-stream"),
            eq(assets.contentType, "application/vnd.git.bundle"),
          ),
        ),
      );

    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      try {
        await deps.storage.deleteObject(candidate.companyId, candidate.objectKey);
        await deps.db
          .delete(issueAttachments)
          .where(
            and(
              eq(issueAttachments.id, candidate.attachmentId),
              eq(issueAttachments.companyId, candidate.companyId),
            ),
          );
        deleted += 1;
      } catch {
        // Keep the row when storage or the database is unavailable. The next
        // scheduler pass retries it without duplicating an attachment.
        failed += 1;
      }
    }
    return { deleted, failed };
  };
}
