import type { Sql } from "postgres";

/**
 * myrmidon(1.6.5-PROCS-T02): a per-query seam at the driver boundary.
 *
 * The board labels its background passes and its API handlers with an
 * AsyncLocalStorage "lane" and counts the queries each lane issues. That
 * counter cannot live here — this package must not reach into the server — so
 * `createDb` wraps the face it hands to drizzle and this module reports every
 * query to a hook the process installs. The hook reads the current lane and
 * bumps its counter.
 *
 * The wrapper is deliberately thin. Drizzle sends every query through
 * `unsafe` (the root client's for ordinary queries, a `begin()`/`savepoint()`
 * scoped client's inside a transaction), so counting `unsafe` counts queries
 * once each — a retried socket write is one query, not two — and the
 * transaction-opening methods only need to keep the scoped client counting.
 * Every other property is passed through untouched.
 *
 * A hook that throws never breaks a query, and a process that installs no hook
 * pays one property lookup per query and nothing else.
 */

/** Called once per query issued on a wrapped client. Must not throw. */
export type DbQueryObserver = () => void;

let observer: DbQueryObserver | null = null;

/** Installs (or clears, with `null`) the per-query hook. Last call wins. */
export function setDbQueryObserver(next: DbQueryObserver | null): void {
  observer = next;
}

/**
 * Reports one query about to be sent. Never throws: measurement must not be
 * able to break the work it measures.
 */
export function notifyDbQuery(): void {
  try {
    observer?.();
  } catch {
    // Metrics never break a query.
  }
}

/** The methods whose first function argument receives a query-carrying client. */
const SCOPED_CLIENT_METHODS = new Set(["begin", "savepoint"]);

/**
 * Returns a client that reports every query to the installed hook and passes
 * everything else through. Wrap the client closest to the caller: one report
 * per query the ORM issues, including the queries inside `db.transaction()`
 * and nested savepoints.
 */
export function withQueryAccounting<T extends Sql>(sql: T): T {
  const wrap = (client: unknown): unknown => {
    // The postgres.js client is callable (`sql`…``), so functions are clients
    // too — only the primitives are not.
    const kind = typeof client;
    if (client === null || (kind !== "object" && kind !== "function")) return client;
    return new Proxy(client as object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "unsafe") {
          return (query: unknown, parameters?: unknown, ...rest: unknown[]) => {
            notifyDbQuery();
            return (value as (...args: unknown[]) => unknown).call(target, query, parameters, ...rest);
          };
        }
        if (SCOPED_CLIENT_METHODS.has(String(property))) {
          return (...args: unknown[]) => {
            const forwarded = args.map((argument) =>
              typeof argument === "function"
                ? (scoped: unknown) =>
                    (argument as (inner: unknown) => unknown)(wrap(scoped))
                : argument,
            );
            return (value as (...args: unknown[]) => unknown).call(target, ...forwarded);
          };
        }
        return value;
      },
    }) as unknown as T;
  };
  return wrap(sql) as unknown as T;
}