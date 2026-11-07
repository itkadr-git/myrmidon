// server/src/myrmidon/litellm-keys/key-spend.ts
//
// myrmidon(OPE-11776): the board's own view of what each agent's gateway key
// spent over the last 24 h and 7 days, read from the litellm_cost_events
// ledger the cost sweep fills. This replaces the host script that scanned the
// gateway's LiteLLM_SpendLogs table (10+ GB) every 15 minutes: the ledger is
// the board's table, the read is one aggregate over a bounded window.
//
// Two readers share it — the per-agent key listing (the LLM module page and
// the budget attention signals) and the authenticated /metrics scrape — so
// the read is
//  - bounded in time: only rows of the last seven days,
//  - bounded in cost: a transaction-local statement_timeout well below the
//    role default, so a slow scan fails fast instead of holding a connection,
//  - shared: one result per database handle is reused for a short TTL and
//    concurrent callers join the read already in flight, so a page reload
//    and a scrape in the same minute cost one query, not two.
// A failed read is never cached.

import { gte, sql } from "drizzle-orm";
import { litellmCostEvents, type Db } from "@myrmidon/db";

/** One agent's ledger spend. Cents, as the ledger stores them. */
export interface AgentSpendWindow {
  companyId: string;
  agentId: string;
  /** Spend in the 24 h before the read. */
  dailyCents: number;
  /** Spend in the 7 days before the read (includes the 24 h). */
  weeklyCents: number;
  /** Ledger rows of the 7 days that cost $0: a route without a price. */
  zeroCostEvents: number;
}

export const AGENT_SPEND_WINDOW_MS = 24 * 3_600_000;
export const AGENT_SPEND_WEEK_MS = 7 * AGENT_SPEND_WINDOW_MS;
/** How long one read is reused. The cost sweep itself runs every few minutes. */
export const AGENT_SPEND_CACHE_TTL_MS = 120_000;

interface CacheEntry {
  at: number;
  rows: Promise<AgentSpendWindow[]>;
}

let cache = new WeakMap<object, CacheEntry>();

/** Forget every cached read: tests, which reuse one database handle across cases. */
export function resetAgentSpendWindowsCache(): void {
  cache = new WeakMap();
}

async function queryAgentSpendWindows(db: Db, now: Date): Promise<AgentSpendWindow[]> {
  // Dates go into the raw sql fragments as ISO strings with an explicit cast:
  // a bare Date parameter inside sql`` is not run through a column encoder and
  // the driver refuses it (the same shape other services in this repo use).
  const dayStartIso = new Date(now.getTime() - AGENT_SPEND_WINDOW_MS).toISOString();
  const weekStart = new Date(now.getTime() - AGENT_SPEND_WEEK_MS);
  const aggregate = async (handle: Db): Promise<AgentSpendWindow[]> => {
    const rows = await handle
      .select({
        companyId: litellmCostEvents.companyId,
        agentId: litellmCostEvents.agentId,
        dailyCents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}) filter (where ${litellmCostEvents.occurredAt} >= ${dayStartIso}::timestamptz), 0)`,
        weeklyCents: sql<number>`coalesce(sum(${litellmCostEvents.costCents}), 0)`,
        zeroCostEvents: sql<number>`count(*) filter (where ${litellmCostEvents.costCents} = 0)`,
      })
      .from(litellmCostEvents)
      .where(gte(litellmCostEvents.occurredAt, weekStart))
      .groupBy(litellmCostEvents.companyId, litellmCostEvents.agentId);
    return rows.map((row) => ({
      companyId: row.companyId,
      agentId: row.agentId,
      dailyCents: Number(row.dailyCents ?? 0),
      weeklyCents: Number(row.weeklyCents ?? 0),
      zeroCostEvents: Number(row.zeroCostEvents ?? 0),
    }));
  };
  // A real handle bounds the statement inside a transaction (set_config with
  // is_local = true: gone at commit). A minimal handle without transaction
  // support — a test double — just runs the aggregate under the role default.
  if (typeof (db as { transaction?: unknown }).transaction !== "function") return aggregate(db);
  return db.transaction(async (rawTx: unknown) => {
    const tx = rawTx as unknown as Db;
    await tx.execute(sql`select set_config('statement_timeout', '10000', true)`);
    return aggregate(tx);
  });
}

/**
 * Ledger spend per agent over the last 24 h and 7 days, for every company in
 * one pass (callers filter by company). Reused for `AGENT_SPEND_CACHE_TTL_MS`.
 */
export function readAgentSpendWindows(db: Db, now: Date = new Date()): Promise<AgentSpendWindow[]> {
  const cached = cache.get(db);
  const clock = Date.now();
  if (cached && clock - cached.at < AGENT_SPEND_CACHE_TTL_MS) return cached.rows;
  const entry: CacheEntry = { at: clock, rows: queryAgentSpendWindows(db, now) };
  cache.set(db, entry);
  entry.rows.catch(() => {
    if (cache.get(db) === entry) cache.delete(db);
  });
  return entry.rows;
}
