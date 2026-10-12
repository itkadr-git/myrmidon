import type { Sql } from "postgres";

/**
 * Reports every statement the client issues, then issues it unchanged.
 *
 * This exists for the board's load lanes (myrmidon 1.6.6 PROCS-0.3A): a lane
 * is an AsyncLocalStorage tag, and the only place that can attribute a DB
 * statement to the lane that caused it is the layer the statement passes
 * through — by the time a query is built, the lane is not an argument of
 * anything. Drizzle routes every non-transactional query through the root
 * client's `unsafe`, so wrapping `unsafe` observes exactly those statements
 * with no change to any query-building code and no per-call-site plumbing.
 *
 * `onQuery` runs in the caller's async context, before the statement is handed
 * to the driver, and once per caller-issued query — a statement replayed by
 * `withTransientWriteRetry` (whose retry is inside this wrapper) is still one
 * query the board asked for.
 *
 * Two deliberate limits, both shared with the retry wrapper:
 * statements inside `db.transaction()` run on the scoped client `sql.begin()`
 * hands out and are not observed, and a driver surface selected by an options
 * argument is passed through untouched.
 *
 * Observation is best-effort by construction: a throwing `onQuery` is
 * swallowed, because a measurement must never be the reason a query fails.
 */
export function withQueryObservation<T extends Sql>(sql: T, onQuery: (query: string) => void): T {
  const report = (query: string): void => {
    try {
      onQuery(query);
    } catch {
      // A broken observer must not break the query it was observing.
    }
  };

  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "unsafe") return Reflect.get(target, property, receiver);
      const unsafe = target.unsafe.bind(target) as (...args: unknown[]) => unknown;
      return (query: string, parameters?: unknown[], ...rest: unknown[]) => {
        report(query);
        return unsafe(query, parameters, ...rest);
      };
    },
  }) as T;
}