// server/src/myrmidon/session-generations/store.ts
//
// myrmidon(PERF-DIET-K): where the state of a task's current session generation
// comes from.
//
// Storage choice (recorded in the PR): the durable record is the run history
// itself — `heartbeat_runs.session_id_after` carries the exact session key the
// gateway adapter used, so a generation's runs, their count and their first
// timestamp are all derivable from rows the board already writes. No table, no
// migration and no column of ours: a schema change here would need a free
// migration number against the vendor's growing journal, and a derived state is
// self-healing after a restore, where a counter table could drift from reality.
//
// The hot path is a wake, and a wake must not query the database every time, so
// the derived state is cached in memory per (agent, task) with a TTL. The
// rotation decision is idempotent — recomputing the state that already crossed
// the threshold yields the same next generation — so a cache that is a little
// stale can only make the same decision twice, never a wrong one.

import { and, desc, eq, like, or } from "drizzle-orm";

import { heartbeatRuns, type Db } from "@paperclipai/db";

import {
  reduceSessionGenerationRows,
  type SessionGenerationRunRow,
  type SessionGenerationState,
} from "./generations.js";

/**
 * How many of the task's newest runs are read. The count only has to exceed the
 * activity threshold for the decision to be right, and `maxMessages` is capped
 * below this by the resolver, so the limit is a bound on the query, not a
 * bound on the decision.
 */
export const DEFAULT_SESSION_GENERATION_SCAN_LIMIT = 600;

/** Cache lifetime of one task's derived state. */
export const DEFAULT_SESSION_GENERATION_CACHE_TTL_MS = 30_000;

/** Upper bound on cached tasks per process; the oldest entry is dropped. */
export const DEFAULT_SESSION_GENERATION_CACHE_MAX_ENTRIES = 500;

export interface SessionGenerationStateQuery {
  companyId: string;
  agentId: string;
  issueId: string;
  /** Rows read from the newest one down; defaults to the constant above. */
  scanLimit?: number;
}

export interface SessionGenerationStateReader {
  readState(query: SessionGenerationStateQuery): Promise<SessionGenerationState>;
}

/**
 * The session key prefix of one task. The generation suffix sits at the end, so
 * the prefix matches every generation of the task — including the unsuffixed
 * first one.
 */
export function sessionKeyPrefix(input: { companyId: string; agentId: string; issueId: string }): string {
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:issue:${input.issueId}`;
}

/** `usage_json`/`result_json` carry the run's own summary under a few names. */
function readRunSummary(resultJson: unknown): string | null {
  if (typeof resultJson !== "object" || resultJson === null || Array.isArray(resultJson)) return null;
  const record = resultJson as Record<string, unknown>;
  for (const key of ["summary", "result", "message"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * The reader over the board's own run history. One bounded query per cache
 * miss: the task's newest runs, selected by the session-key prefix on either
 * session id, reduced by the pure function above.
 */
export function createDbSessionGenerationStateReader(db: Db): SessionGenerationStateReader {
  return {
    async readState(query) {
      const prefix = sessionKeyPrefix(query);
      const scanLimit = Math.max(1, query.scanLimit ?? DEFAULT_SESSION_GENERATION_SCAN_LIMIT);
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          createdAt: heartbeatRuns.createdAt,
          sessionIdAfter: heartbeatRuns.sessionIdAfter,
          sessionIdBefore: heartbeatRuns.sessionIdBefore,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, query.companyId),
            eq(heartbeatRuns.agentId, query.agentId),
            or(
              like(heartbeatRuns.sessionIdAfter, `${prefix}%`),
              like(heartbeatRuns.sessionIdBefore, `${prefix}%`),
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(scanLimit);

      const reduced: SessionGenerationRunRow[] = rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        sessionIdAfter: row.sessionIdAfter,
        sessionIdBefore: row.sessionIdBefore,
        resultSummary: readRunSummary(row.resultJson),
      }));
      return reduceSessionGenerationRows({ rows: reduced, sessionKeyPrefix: prefix });
    },
  };
}

export interface SessionGenerationCache {
  read(query: SessionGenerationStateQuery): Promise<SessionGenerationState>;
  /** Cached tasks; a test seam. */
  size(): number;
}

/**
 * The in-memory TTL cache in front of a reader. A hit inside the TTL answers
 * without touching the database; a miss reads and remembers. The clock is
 * injectable so a test never waits.
 */
export function createSessionGenerationCache(options: {
  reader: SessionGenerationStateReader;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): SessionGenerationCache {
  const ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_SESSION_GENERATION_CACHE_TTL_MS);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_SESSION_GENERATION_CACHE_MAX_ENTRIES);
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { state: SessionGenerationState; expiresAt: number }>();

  function prune(nowMs: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= nowMs) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    async read(query) {
      const key = `${query.companyId}:${query.agentId}:${query.issueId}:${query.scanLimit ?? DEFAULT_SESSION_GENERATION_SCAN_LIMIT}`;
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) return cached.state;
      const state = await options.reader.readState(query);
      const nowMs = now();
      // Re-insert so this task becomes the newest entry, then drop the expired
      // ones and, past the bound, the oldest — never the entry just written.
      entries.delete(key);
      entries.set(key, { state, expiresAt: nowMs + ttlMs });
      prune(nowMs);
      return state;
    },
    size() {
      return entries.size;
    },
  };
}