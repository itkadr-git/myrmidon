// server/src/myrmidon/tool-policy-cache/runtime.ts
//
// myrmidon(DB-PERF-C-P4): the one cache per server process.
//
// `toolAccessPolicyService(db)` is built again on every gateway request, so a
// cache held by the service instance would be born and die with the request and
// never take a hit. The cache therefore lives here, at module level, keyed by
// the database handle: one cache per process in production, and one per handle
// in tests, so two tests (or two installations sharing a process) never share a
// snapshot.
//
// The TTL is not a constant and not an environment variable: it is read from
// `instance_settings.general.toolPolicyCache` on every cache access, so an
// operator's change applies to the next gateway call without a restart (the
// same contract the agent-memory settings follow).

import type { Db } from "@paperclipai/db";
import { resolveToolPolicyCacheTtlMs } from "@paperclipai/shared";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createToolPolicyCache, type ToolPolicyCache, type ToolPolicyCacheStats } from "./cache.js";
import { createToolPolicySnapshotLoader } from "./loader.js";
import { readStoredToolPolicyCacheSettings } from "./settings.js";
import type { ToolPolicySnapshot } from "./snapshot.js";

const caches = new Map<Db, ToolPolicyCache>();

/**
 * A drizzle transaction handle (it carries `rollback`; the root handle does
 * not). Services are sometimes built on a caller's transaction: such a handle
 * is a different object per transaction, so it must never own a cache of its
 * own (one cache per transaction would be an unbounded leak and, with the rows
 * uncommitted, a source of stale snapshots).
 */
function isTransactionHandle(db: Db): boolean {
  return typeof (db as unknown as { rollback?: unknown }).rollback === "function";
}

export function toolPolicyCache(db: Db): ToolPolicyCache {
  const existing = caches.get(db);
  if (existing) return existing;
  const settings = instanceSettingsService(db);
  const cache = createToolPolicyCache({
    load: createToolPolicySnapshotLoader(db),
    readTtlMs: async () =>
      resolveToolPolicyCacheTtlMs(readStoredToolPolicyCacheSettings(await settings.getGeneral())),
  });
  caches.set(db, cache);
  return cache;
}

/**
 * The snapshot of a company for the gateway's next decision, or `null` when the
 * cache is switched off (`ttlMs: 0`) — the caller then runs its own reads, so a
 * switched-off cache leaves the gateway query path exactly as it was.
 */
export function readToolPolicySnapshot(db: Db, companyId: string): Promise<ToolPolicySnapshot | null> {
  // Inside a transaction the rows may be uncommitted and the handle is not the
  // process's: read them directly, as the gateway did before the cache.
  if (isTransactionHandle(db)) return Promise.resolve(null);
  return toolPolicyCache(db).read(companyId);
}

/**
 * Drop the company's snapshot. Called after a commit that changed a policy, a
 * profile, a binding or a profile entry: the next decision in the company reads
 * the new rows without waiting out the TTL. It never creates a cache — an
 * invalidation before the first read is a no-op.
 */
export function invalidateToolPolicyCache(db: Db, companyId: string): void {
  const own = caches.get(db);
  if (own) {
    own.invalidate(companyId);
    return;
  }
  // A handle that owns no cache is a caller's transaction (or another handle on
  // the same database): its writes still change what every cache of this process
  // would load, so drop the company everywhere instead of silently doing nothing.
  // Callers that write inside a transaction must also invalidate after the commit.
  for (const cache of caches.values()) cache.invalidate(companyId);
}

/** Drop every snapshot of this process (or of one database handle, in tests). */
export function invalidateAllToolPolicyCaches(db?: Db): void {
  if (db) {
    caches.get(db)?.invalidateAll();
    return;
  }
  for (const cache of caches.values()) cache.invalidateAll();
}

export function toolPolicyCacheStats(db: Db): ToolPolicyCacheStats {
  return caches.get(db)?.stats() ?? { companies: 0, loads: 0, hits: 0, misses: 0, ttlMs: 0 };
}

/** Test seam: forget the caches of every database handle. */
export function __resetToolPolicyCachesForTests(): void {
  caches.clear();
}