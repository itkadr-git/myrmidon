// myrmidon(EMPTY-RUNS-3): helpers for a transaction that two requests of the
// same object can run at once.
//
// - `postgresErrorInfo` reads the Postgres code and text of an error. The query
//   builder wraps the driver's error: the wrapper's text is the statement, the
//   reason (`deadlock detected`, SQLSTATE 40P01) is on its `cause`, so a log
//   line made from the wrapper alone has no reason.
// - `runTransactionWithRetry` runs a whole transaction again when Postgres
//   rolled it back because of a deadlock (40P01) or a serialization failure
//   (40001), a bounded number of times.
// - `lockObjectInTransaction` takes a transaction-level advisory lock on a key,
//   so transactions of one object (one pull request) run one after another
//   instead of taking its rows in their own order.

import { sql } from "drizzle-orm";

export type PostgresErrorInfo = {
  code: string;
  message: string;
  severity?: string;
  table?: string;
  constraint?: string;
};

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 4;
const MAX_MESSAGE_LENGTH = 300;

/** SQLSTATE codes after which the same transaction may simply be run again. */
export const RETRYABLE_POSTGRES_CODES: ReadonlySet<string> = new Set(["40P01", "40001"]);

function textField(value: unknown, limit = 120): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

/**
 * The Postgres error behind `error` (the error itself or one of its `cause`s),
 * or null when it is not a database error. Only the code, the reason text and
 * the names of the table and constraint are returned: not the statement, not
 * its parameters, not the row `detail`.
 */
export function postgresErrorInfo(error: unknown): PostgresErrorInfo | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current && typeof current === "object"; depth += 1) {
    const candidate = current as Record<string, unknown>;
    const code = candidate.code;
    if (typeof code === "string" && SQLSTATE_PATTERN.test(code) && typeof candidate.message === "string") {
      const severity = textField(candidate.severity, 20);
      const table = textField(candidate.table);
      const constraint = textField(candidate.constraint);
      return {
        code,
        message: candidate.message.slice(0, MAX_MESSAGE_LENGTH),
        ...(severity ? { severity } : {}),
        ...(table ? { table } : {}),
        ...(constraint ? { constraint } : {}),
      };
    }
    current = candidate.cause;
  }
  return null;
}

export function isRetryablePostgresError(error: unknown): boolean {
  const info = postgresErrorInfo(error);
  return info !== null && RETRYABLE_POSTGRES_CODES.has(info.code);
}

export type TransactionRetryOptions = {
  /** Total runs, the first one included. Default 4. */
  attempts?: number;
  /** Pause before run n (1-based) is `baseDelayMs * n` plus up to the same again. Default 25. */
  baseDelayMs?: number;
  /** Called before every repeated run. */
  onRetry?: (info: { attempt: number; error: PostgresErrorInfo }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/**
 * Runs `run` (one whole transaction, which must leave nothing behind outside it
 * that a repeat would duplicate) and runs it again when Postgres rolled it
 * back with 40P01 or 40001. Any other error, and the last failed run, are
 * thrown as they are.
 */
export async function runTransactionWithRetry<T>(
  run: (attempt: number) => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = options.baseDelayMs ?? 25;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      const info = postgresErrorInfo(error);
      if (attempt >= attempts || !info || !RETRYABLE_POSTGRES_CODES.has(info.code)) throw error;
      options.onRetry?.({ attempt, error: info });
      await sleep(baseDelayMs * attempt * (1 + random()));
    }
  }
}

/**
 * Waits for, and holds until the end of the transaction, the advisory lock of
 * `key`. Two transactions with the same key run one after another; a waiting
 * one holds no row of the object yet, so they cannot wait for each other.
 */
export async function lockObjectInTransaction(
  tx: { execute: (query: ReturnType<typeof sql>) => PromiseLike<unknown> },
  key: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
