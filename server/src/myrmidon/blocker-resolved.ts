// myrmidon(BLOCKED-REASON, ADM decision 24.10): the single source of truth for
// "this blocker is resolved". A blocker in `done` or `cancelled` no longer holds
// its dependents: a cancelled blocker can never finish, so waiting on it would
// strand the dependent. The workspace sync-back barrier is a separate condition
// that applies on top of `done` blockers only; it is not part of this rule.
//
// TS callers use `isBlockerResolved` / `isBlockerOpen`; drizzle callers use
// `blockerOpenCondition(column)`; raw SQL fragments use `blockerOpenSql(ref)`.
import { notInArray, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

export const RESOLVED_BLOCKER_STATUSES = ["done", "cancelled"] as const;

export function isBlockerResolved(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

/** A missing blocker row counts as open only when the caller says so; unknown status is open. */
export function isBlockerOpen(status: string | null | undefined): boolean {
  return !isBlockerResolved(status);
}

/** drizzle condition: the blocker status column is not resolved. */
export function blockerOpenCondition(statusColumn: AnyColumn): SQL {
  return notInArray(statusColumn, [...RESOLVED_BLOCKER_STATUSES]);
}

const SQL_COLUMN_REF = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

/** Raw SQL fragment `<ref> not in ('done', 'cancelled')` for hand-written subqueries. */
export function blockerOpenSql(statusColumnRef: string): SQL {
  if (!SQL_COLUMN_REF.test(statusColumnRef)) throw new Error("bad column reference");
  return sql.raw(`${statusColumnRef} not in (${RESOLVED_BLOCKER_STATUSES.map((s) => `'${s}'`).join(", ")})`);
}
