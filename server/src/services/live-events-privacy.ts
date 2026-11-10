import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@myrmidon/db";
import type { LiveEvent } from "@myrmidon/shared";

/**
 * Live-events privacy for agent sockets (PRIVATE-TASKS E3).
 *
 * Agent API keys may subscribe to their company's live-events socket, so
 * every company event would otherwise reach agents that REST access rules
 * (PRIVATE-TASKS B) already hide private issues from. Events that reference
 * a private issue must not be delivered to agent sockets.
 */

const PRIVACY_CACHE_TTL_MS = 5000;
const PRIVACY_CACHE_MAX_ENTRIES = 4096;

interface PrivacyCacheEntry {
  isPrivate: boolean;
  expiresAt: number;
}

/** Shared across sockets: repeated events for one issue hit the cache, not the DB. */
const privacyCache = new Map<string, PrivacyCacheEntry>();

/**
 * Resolves the issue an event belongs to, or null when the event has no
 * issue relation (e.g. agent.status, heartbeat.run.* without issueId).
 * Only issue-scoped activity rows carry the issue in entityId; every other
 * event type carries it in payload.issueId.
 */
export function extractIssueReference(event: LiveEvent): string | null {
  if (event.type === "activity.logged") {
    if (event.payload.entityType !== "issue") return null;
    const entityId = event.payload.entityId;
    return typeof entityId === "string" && entityId.length > 0 ? entityId : null;
  }

  const issueId = event.payload.issueId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

/**
 * Whether the issue is private in this company. Throws when the lookup
 * fails — callers must treat a throw as "not visible" (fail closed).
 * A row that does not resolve in this company (deleted, or cross-company
 * id) reports private so it never opens the stream.
 */
export async function isIssuePrivateForCompany(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const key = `${companyId}:${issueId}`;
  const now = Date.now();
  const cached = privacyCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.isPrivate;
  }

  const rows = await db
    .select({ isPrivate: issues.isPrivate })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1);

  const isPrivate = rows[0]?.isPrivate ?? true;

  privacyCache.set(key, { isPrivate, expiresAt: now + PRIVACY_CACHE_TTL_MS });
  if (privacyCache.size > PRIVACY_CACHE_MAX_ENTRIES) {
    evictPrivacyCache(now);
  }

  return isPrivate;
}

function evictPrivacyCache(now: number) {
  for (const [key, entry] of privacyCache) {
    if (entry.expiresAt <= now) privacyCache.delete(key);
  }
  if (privacyCache.size > PRIVACY_CACHE_MAX_ENTRIES) {
    privacyCache.clear();
  }
}
