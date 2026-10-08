// server/src/myrmidon/datastore-care/retention/compact.ts
//
// myrmidon(1.6.5-DBC1): the context_snapshot compactor of DB-CARE O1a.
//
// A terminal heartbeat run keeps its whole wake context in
// `heartbeat_runs.context_snapshot`: the continuation envelope
// (`executionContinuation` with its message history), the task markdown and
// the wake payload are the biggest JSONB values in the table and they stay
// there forever after the run ends. This module rewrites the snapshot of
// runs older than the retention window, stripping exactly the heavy
// continuation keys listed below (the O1a key list) and stamping
// `_compactedAt` so the compacted rows are recognizable in SQL. Small keys
// (identifiers, wake reason, taskKey, issueId) stay — attention-feed
// derivations and audit queries read them.
//
// The batch query is the rewritten O1a selection: a `created_at` window on
// one company (`created_at < cutoff`) ordered ascending, served by the
// `heartbeat_runs_company_created_at_desc_idx` index, at most
// CONTEXT_COMPACT_BATCH_SIZE (500) rows per statement under a
// `statement_timeout`, with a pause between batches. A pass never holds a
// long lock: it is many small transactions, and the rest of the backlog
// waits for the next sweep tick. Compaction is idempotent — a row without
// any of the keys drops out of the selection predicate.
//
// Compaction is a rewrite, not a delete: the row, its status and its small
// context survive; only the bulky continuation payloads go. The caller runs
// it only when the backup gate is fresh (the row rewrite is restorable from
// a backup) and outside maintenance windows.

import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";

/** Rows compacted per statement (O1a). */
export const CONTEXT_COMPACT_BATCH_SIZE = 500;

/** Batches per company per pass; the rest of the backlog waits for the next tick. */
export const CONTEXT_COMPACT_MAX_BATCHES = 10;

/** Pause between batches, so the pass never saturates the connection pool. */
export const CONTEXT_COMPACT_PAUSE_MS = 250;

/** The per-batch statement timeout; a pathological batch gives up and retries next tick. */
export const CONTEXT_COMPACT_STATEMENT_TIMEOUT_MS = 30_000;

/** The marker key stamped into a compacted snapshot (O1a). */
export const CONTEXT_COMPACTED_AT_KEY = "_compactedAt";

/**
 * The O1a key list: the bulky continuation payloads of a finished run.
 * Everything else in the snapshot stays.
 */
export const CONTEXT_COMPACT_KEYS = [
  "executionContinuation",
  "paperclipWake",
  "paperclipWakeComment",
  "paperclipTaskMarkdown",
  "paperclipTaskMarkdownCompact",
  "paperclipSessionHandoffMarkdown",
  "paperclipContinuationSummary",
  "externalChatContinuation",
] as const;

/** The live (non-terminal) run statuses; a run with one of them is never touched. */
export const CONTEXT_COMPACT_LIVE_STATUSES = HEARTBEAT_RUN_STATUSES.filter(
  (status) => status === "queued" || status === "scheduled_retry" || status === "running",
);

export interface CompactBatchResult {
  compacted: number;
  freedBytes: number;
}

export interface CompanyCompactResult extends CompactBatchResult {
  companyId: string;
}

/**
 * Pure half of the compaction: strip the O1a keys from a snapshot object
 * and stamp the marker. Returns null when the snapshot holds none of the
 * keys (nothing to do — the row stays byte-identical). Exported for tests
 * and for any future in-process caller; the production path is the SQL in
 * `compactCompanyBatch`.
 */
export function compactContextSnapshot(
  snapshot: Record<string, unknown>,
  compactedAt: string,
): { snapshot: Record<string, unknown>; removedKeys: string[] } | null {
  const removedKeys = CONTEXT_COMPACT_KEYS.filter((key) => key in snapshot);
  if (removedKeys.length === 0) return null;
  const next: Record<string, unknown> = { ...snapshot };
  for (const key of removedKeys) delete next[key];
  next[CONTEXT_COMPACTED_AT_KEY] = compactedAt;
  return { snapshot: next, removedKeys };
}

/** Statement- timeout / lock errors: the batch yields, the next pass retries. */
export function isCompactBlockedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "57014" /* query_canceled: statement_timeout */ || code === "55P03";
}

// The strip expression is built from the module constant list — no user
// input reaches sql.raw.
const stripKeysSql = sql.raw(
  CONTEXT_COMPACT_KEYS.map((key) => ` - '${key}'`).join(""),
);

const liveStatusesSql = sql.join(
  CONTEXT_COMPACT_LIVE_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

const holdsKeySql = sql.join(
  CONTEXT_COMPACT_KEYS.map((key) => sql`jsonb_exists(context_snapshot, ${key})`),
  sql` OR `,
);

/**
 * Compact one batch of terminal runs of one company inside `tx`: select at
 * most CONTEXT_COMPACT_BATCH_SIZE rows in the created_at window, strip the
 * O1a keys, stamp `_compactedAt`, and report the row count with the freed
 * bytes (pg_column_size before minus after — an exact figure for the
 * snapshot values themselves).
 */
export async function compactCompanyBatch(
  tx: Db,
  input: { companyId: string; cutoff: string; compactedAt: string },
): Promise<CompactBatchResult> {
  const rows = (await tx.execute(sql`
    WITH picked AS (
      SELECT id, pg_column_size(context_snapshot) AS size_before
      FROM heartbeat_runs
      WHERE company_id = ${input.companyId}
        AND created_at < ${input.cutoff}::timestamptz
        AND status NOT IN (${liveStatusesSql})
        AND (${holdsKeySql})
      ORDER BY created_at
      LIMIT ${CONTEXT_COMPACT_BATCH_SIZE}
    ),
    compacted AS (
      UPDATE heartbeat_runs hr
      SET context_snapshot =
          (hr.context_snapshot${stripKeysSql})
          || jsonb_build_object(${CONTEXT_COMPACTED_AT_KEY}::text, ${input.compactedAt}::text)
      FROM picked p
      WHERE hr.id = p.id
      RETURNING (p.size_before - pg_column_size(hr.context_snapshot)) AS saved_bytes
    )
    SELECT count(*)::int AS compacted,
           coalesce(sum(greatest(saved_bytes, 0)), 0)::bigint AS freed_bytes
    FROM compacted
  `)) as unknown as Array<{ compacted: number | string; freed_bytes: number | string }>;
  const row = rows[0] ?? { compacted: 0, freed_bytes: 0 };
  return {
    compacted: Number(row.compacted) || 0,
    freedBytes: Number(row.freed_bytes) || 0,
  };
}

export interface CompactPassDeps {
  db: Db;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: stop a pass after this many batches per company. */
  maxBatches?: number;
}

export interface CompactPassResult {
  compacted: number;
  freedBytes: number;
  /** True when the pass stopped on a statement-timeout batch (rest waits for the next tick). */
  timedOut: boolean;
  /** Per-company totals; companies without work are omitted. */
  perCompany: CompanyCompactResult[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compact every terminal run older than `cutoff` across `companyIds`, in
 * paced batches under the statement timeout. One small transaction per
 * batch; a blocked batch aborts only its own transaction and the pass
 * reports `timedOut` so the caller can log the yield.
 */
export async function compactContextPass(
  deps: CompactPassDeps,
  input: { companyIds: string[]; cutoff: string; compactedAt: string },
): Promise<CompactPassResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const maxBatches = deps.maxBatches ?? CONTEXT_COMPACT_MAX_BATCHES;
  let compacted = 0;
  let freedBytes = 0;
  let timedOut = false;
  const perCompany: CompanyCompactResult[] = [];
  for (const companyId of input.companyIds) {
    let companyCompacted = 0;
    let companyFreedBytes = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      let result: CompactBatchResult;
      try {
        result = await deps.db.transaction(async (tx) => {
          await tx.execute(
            // SET does not accept bind parameters; the timeout is a module constant.
            sql.raw(`SET LOCAL statement_timeout = ${CONTEXT_COMPACT_STATEMENT_TIMEOUT_MS}`),
          );
          return compactCompanyBatch(tx as unknown as Db, {
            companyId,
            cutoff: input.cutoff,
            compactedAt: input.compactedAt,
          });
        });
      } catch (err) {
        if (isCompactBlockedError(err)) {
          timedOut = true;
          break; // this company yields; the next one is a fresh window
        }
        throw err;
      }
      companyCompacted += result.compacted;
      companyFreedBytes += result.freedBytes;
      if (result.compacted < CONTEXT_COMPACT_BATCH_SIZE) break;
      await sleep(CONTEXT_COMPACT_PAUSE_MS);
    }
    if (companyCompacted > 0) {
      perCompany.push({ companyId, compacted: companyCompacted, freedBytes: companyFreedBytes });
    }
    compacted += companyCompacted;
    freedBytes += companyFreedBytes;
  }
  return { compacted, freedBytes, timedOut, perCompany };
}
