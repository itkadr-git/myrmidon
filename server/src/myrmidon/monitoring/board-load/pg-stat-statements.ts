// server/src/myrmidon/monitoring/board-load/pg-stat-statements.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the DB hot-statement report of design OPE-5394 §1 П4.
//
// The measurement that matters for a board whose DB work is the problem is
// `pg_stat_statements` ordered by `total_exec_time` — "which statements cost
// the database the most time in total". Reading it needed an operator with a
// psql session on the production database; this module answers it from the
// board process, on the board's own pool.
//
// Installing the extension and the `shared_preload_libraries` entry is *not*
// this ticket's job (that is part B, an operator change with a restart).
// What this code owes is the other half: it must answer correctly when the
// extension is absent, not installed into the database, or not loaded — a
// monitoring endpoint that throws a 500 on a database without the extension is
// useless exactly when someone is looking for it. Hence the typed
// `available: false` answers below: the caller reports the reason, and the
// board's default behaviour stays untouched.

import { sql } from "drizzle-orm";

/** Rows the report returns unless the caller asks for another count. */
export const PG_STAT_STATEMENTS_DEFAULT_LIMIT = 20;
/** Upper bound of rows per report: the view is ordered by total time. */
export const PG_STAT_STATEMENTS_MAX_LIMIT = 50;
/** Statement text longer than this is trimmed in the report. */
export const PG_STAT_STATEMENTS_MAX_QUERY_TEXT = 2000;

export interface PgStatementRow {
  query: string;
  calls: number;
  /** Total time in milliseconds (the sort key). */
  totalMs: number;
  /** Mean time per call in milliseconds. */
  meanMs: number;
  /** Rows the statement returned or affected, summed over calls. */
  rows: number;
}

export type PgStatStatementsUnavailableReason =
  | "extension_missing"
  | "extension_not_loaded"
  | "no_privilege";

export type PgStatStatementsRead =
  | { available: true; rows: PgStatementRow[] }
  | { available: false; reason: PgStatStatementsUnavailableReason; detail: string };

/** The slice of the DB client this report needs (`Db` satisfies it). */
export interface PgStatStatementsDbPort {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Coerces a request value into the allowed row count.
 *
 * A wrong value collapses to the default rather than failing: the endpoint's
 * job is to answer, and 20 rows is the documented report.
 */
export function clampPgStatStatementsLimit(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return PG_STAT_STATEMENTS_DEFAULT_LIMIT;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > PG_STAT_STATEMENTS_MAX_LIMIT) return PG_STAT_STATEMENTS_MAX_LIMIT;
  return whole;
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Maps a failed `pg_stat_statements` read to the reason an operator can act on,
 * or `null` when the failure has nothing to do with the extension (and must
 * therefore reach the caller as an error instead of being reported as a
 * configuration gap).
 *
 * The code is checked first — `42P01` (undefined table) is what a database
 * without the extension installed returns, `55000` is what a database without
 * the `shared_preload_libraries` entry returns once the view exists. The
 * message check is a fallback for poolers and for PostgreSQL builds that report
 * the shared-preload case with a different code; matching the documented text
 * is still better than reporting "the extension is fine" for a view that
 * cannot be read.
 */
export function classifyPgStatStatementsError(
  error: unknown,
): { reason: PgStatStatementsUnavailableReason; detail: string } | null {
  const code = errorCode(error);
  const detail = errorMessage(error);
  if (code === "42P01" || code === "42704") return { reason: "extension_missing", detail };
  if (code === "55000") return { reason: "extension_not_loaded", detail };
  if (code === "42501") return { reason: "no_privilege", detail };
  if (/pg_stat_statements/i.test(detail)) {
    if (/must be loaded via shared_preload_libraries/i.test(detail)) {
      return { reason: "extension_not_loaded", detail };
    }
    if (/does not exist|undefined (table|object)/i.test(detail)) {
      return { reason: "extension_missing", detail };
    }
    if (/permission denied/i.test(detail)) return { reason: "no_privilege", detail };
  }
  return null;
}

function toCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowsFrom(queryResult: unknown): unknown[] {
  if (Array.isArray(queryResult)) return queryResult;
  if (queryResult && typeof queryResult === "object" && Symbol.iterator in queryResult) {
    return Array.from(queryResult as Iterable<unknown>);
  }
  return [];
}

function mapRow(row: unknown): PgStatementRow {
  const record = (row ?? {}) as Record<string, unknown>;
  const text = typeof record.query === "string" ? record.query : "";
  return {
    query: text.length > PG_STAT_STATEMENTS_MAX_QUERY_TEXT ? text.slice(0, PG_STAT_STATEMENTS_MAX_QUERY_TEXT) : text,
    calls: toCount(record.calls),
    totalMs: toCount(record.total_ms),
    meanMs: toCount(record.mean_ms),
    rows: toCount(record.rows),
  };
}

function isUndefinedColumn(error: unknown): boolean {
  return errorCode(error) === "42703";
}

/**
 * Reads the top `limit` statements by total execution time.
 *
 * PostgreSQL 13 renamed the timing columns (`total_time` → `total_exec_time`),
 * and the board runs on a version it does not pin, so the newer name is tried
 * first and the older one answers a `42703` (undefined column). Only a failure
 * whose reason is known degrades to `available: false`; anything else is
 * rethrown, because "unknown failure" must not be dressed up as "not
 * configured".
 */
export async function readPgStatStatements(
  db: PgStatStatementsDbPort,
  limit: number,
): Promise<PgStatStatementsRead> {
  const newer = sql`
    select query, calls, total_exec_time as total_ms, mean_exec_time as mean_ms, rows
    from pg_stat_statements
    order by total_exec_time desc
    limit ${limit}
  `;
  const older = sql`
    select query, calls, total_time as total_ms, mean_time as mean_ms, rows
    from pg_stat_statements
    order by total_time desc
    limit ${limit}
  `;

  let result: unknown;
  try {
    result = await db.execute(newer);
  } catch (error) {
    if (!isUndefinedColumn(error)) {
      const classified = classifyPgStatStatementsError(error);
      if (classified) return { available: false, ...classified };
      throw error;
    }
    try {
      result = await db.execute(older);
    } catch (olderError) {
      const classified = classifyPgStatStatementsError(olderError);
      if (classified) return { available: false, ...classified };
      throw olderError;
    }
  }

  return { available: true, rows: rowsFrom(result).map(mapRow) };
}