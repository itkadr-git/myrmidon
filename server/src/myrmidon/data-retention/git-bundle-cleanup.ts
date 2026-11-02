import { and, eq, ilike, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { assets, issueAttachments, issues } from "@myrmidon/db";
import type { StorageService } from "../../storage/types.js";

/** Closed-task git bundles are registered with this immutable asset filename. */
export const GIT_BUNDLE_ATTACHMENT_FILENAME = "workspace.bundle";
export const CLOSED_TASK_GIT_BUNDLE_GRACE_DAYS = 2;
export const GIT_BUNDLE_CONTENT_TYPES = [
  "application/octet-stream",
  "application/vnd.git.bundle",
  "application/x-git-bundle",
] as const;

export function isGitBundleFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const lower = filename.trim().toLowerCase();
  return lower === GIT_BUNDLE_ATTACHMENT_FILENAME || lower.endsWith(".bundle");
}

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
 * operation leaves the database rows for the next idempotent retry.
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
        assetId: assets.id,
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
          or(
            eq(assets.originalFilename, GIT_BUNDLE_ATTACHMENT_FILENAME),
            ilike(assets.originalFilename, "%.bundle"),
          ),
          inArray(assets.contentType, [...GIT_BUNDLE_CONTENT_TYPES]),
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
        await deps.db
          .delete(assets)
          .where(
            and(
              eq(assets.id, candidate.assetId),
              eq(assets.companyId, candidate.companyId),
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
