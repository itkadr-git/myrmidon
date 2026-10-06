// server/src/myrmidon/tool-policy-cache/cache.ts
//
// myrmidon(DB-PERF-C-P4): the in-process TTL cache of the tool gateway's policy
// reads.
//
// The gateway decides access on every `tools/list` and every tool call. Each
// decision used to pay four SELECTs (`tool_profile_bindings`, `tool_profiles`,
// `tool_profile_entries`, the enabled `tool_policies`) plus the gateway row;
// the tables are nearly empty, so the cost is the round trips, not the rows —
// ~5.4M statements over three days of statistics.
//
// Shape: a Map keyed by companyId holding { snapshot, cachedAt }. A Map keeps
// insertion order, so re-inserting a company on a hit moves it to the back: at
// the cap the oldest key — the least recently used — is evicted. The TTL comes
// from an async provider that is asked on every read, so an operator's change
// applies to the next gateway call without a restart. `ttlMs <= 0` means the
// cache is off: every read reports "no snapshot" instead of loading one, any
// entry left over from an earlier window is dropped, and the caller falls back
// to its own reads, statement for statement.
//
// The snapshot is shared by every caller of the company within the window: it
// is read-only (the gateway filters and maps, never mutates rows or the
// arrays), so no defensive copy is made.

import type { ToolPolicyCacheRows, ToolPolicySnapshot } from "./snapshot.js";

/** Loads the full row sets of one company. Called only on a miss. */
export type ToolPolicySnapshotLoader = (companyId: string) => Promise<ToolPolicyCacheRows>;

export interface ToolPolicyCacheStats {
  /** Companies currently held in the cache. */
  companies: number;
  /** Snapshot loads that reached the database. */
  loads: number;
  /** Reads answered from the cache. */
  hits: number;
  /** Reads that had to load (miss, expired entry, or the cache switched off). */
  misses: number;
  /** Last TTL the provider returned, in milliseconds; 0 means the cache is off. */
  ttlMs: number;
}

export interface ToolPolicyCache {
  /**
   * The snapshot of a company: from the cache while it is fresh, otherwise
   * loaded. `null` means the cache is switched off — the caller runs its own
   * reads, so switching the cache off restores the pre-cache query path.
   */
  read(companyId: string): Promise<ToolPolicySnapshot | null>;
  /** Drops the company's snapshot: the next read reloads it. */
  invalidate(companyId: string): void;
  /** Drops every snapshot held by this cache. */
  invalidateAll(): void;
  /** The cached snapshot, or null when there is none (test/debug seam). */
  peek(companyId: string): ToolPolicySnapshot | null;
  stats(): ToolPolicyCacheStats;
}

export interface CreateToolPolicyCacheInput {
  load: ToolPolicySnapshotLoader;
  /** Read on every cache access: the live TTL in milliseconds. */
  readTtlMs: () => number | Promise<number>;
  now?: () => number;
  /** Upper bound on held companies; the least recently used entry is evicted. */
  cap?: number;
}

/**
 * Upper bound on cached companies. One entry per company that made a gateway
 * call inside the window; on a board sized for this fleet the cap is never
 * reached, and it keeps the map bounded if a fault ever hands it many ids.
 */
export const TOOL_POLICY_CACHE_COMPANY_CAP = 1000;

interface CacheEntry {
  snapshot: ToolPolicySnapshot;
  cachedAt: number;
}

export function createToolPolicyCache(input: CreateToolPolicyCacheInput): ToolPolicyCache {
  const store = new Map<string, CacheEntry>();
  const cap = Math.max(1, input.cap ?? TOOL_POLICY_CACHE_COMPANY_CAP);
  const now = input.now ?? (() => Date.now());
  let loads = 0;
  let hits = 0;
  let misses = 0;
  let lastTtlMs = 0;

  function evictIfNeeded(keep: string): void {
    while (store.size > cap) {
      const oldest = store.keys().next();
      if (oldest.done || oldest.value === keep) return;
      store.delete(oldest.value);
    }
  }

  async function loadSnapshot(companyId: string): Promise<ToolPolicySnapshot> {
    loads += 1;
    const rows = await input.load(companyId);
    return { ...rows, cachedAt: now() };
  }

  return {
    async read(companyId: string): Promise<ToolPolicySnapshot | null> {
      const ttlMs = Number(await input.readTtlMs());
      lastTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 0;
      if (lastTtlMs === 0) {
        // Switched off: never serve a stored snapshot in this mode, and do not fill
        // the cache either — the caller runs its own reads, so the query path is the
        // one it had before the cache existed.
        store.delete(companyId);
        misses += 1;
        return null;
      }
      const entry = store.get(companyId);
      if (entry && now() - entry.cachedAt < lastTtlMs) {
        hits += 1;
        store.delete(companyId);
        store.set(companyId, entry);
        return entry.snapshot;
      }
      misses += 1;
      const snapshot = await loadSnapshot(companyId);
      store.delete(companyId);
      store.set(companyId, { snapshot, cachedAt: snapshot.cachedAt });
      evictIfNeeded(companyId);
      return snapshot;
    },

    invalidate(companyId: string): void {
      store.delete(companyId);
    },

    invalidateAll(): void {
      store.clear();
    },

    peek(companyId: string): ToolPolicySnapshot | null {
      return store.get(companyId)?.snapshot ?? null;
    },

    stats(): ToolPolicyCacheStats {
      return { companies: store.size, loads, hits, misses, ttlMs: lastTtlMs };
    },
  };
}