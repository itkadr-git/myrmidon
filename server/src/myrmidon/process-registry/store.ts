// server/src/myrmidon/process-registry/store.ts
//
// myrmidon(1.6.6 PROCS-0.1): the DB side of the process registry — one upsert
// per pulse, one read for the panel, one delete for the leader's reaping.

import { asc, lt } from "drizzle-orm";
import { boardProcesses, type Db } from "@paperclipai/db";
import type { BoardProcessIdentity } from "./domain.js";

/** The pulse's per-tick measurements; null while an observer is unavailable.
 *
 * `eventLoopLagMs` reaches the column as a WHOLE number of milliseconds: the
 * observer (`monitorEventLoopDelay` nanosecond percentiles converted to ms)
 * produces a fraction, `board_processes.event_loop_lag_ms` is `integer` — the
 * convention of every `*_ms` gauge in this schema — and Postgres answers 22P02
 * for a fractional value into int4. The pulse reports a failed tick through
 * `onError` and keeps ticking, so a fraction here would leave the row (and the
 * whole «Процессы» panel) permanently empty instead of failing loudly. The
 * store therefore rounds at the boundary, where the value meets the column.
 */
export type BoardProcessPulseUpdate = {
  eventLoopLagMs: number | null;
  rssBytes: number | null;
};

/** Whole milliseconds for `board_processes.event_loop_lag_ms`. A reading that
 * is not a finite number (NaN/Infinity) is recorded as "no measurement" — it
 * must not reach an int4 column either. */
function wholeMilliseconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

export type BoardProcessRow = {
  bootId: string;
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  startedAt: Date;
  lastSeenAt: Date;
  apiPort: number | null;
  eventLoopLagMs: number | null;
  rssBytes: number | null;
};

export interface BoardProcessStore {
  /** Writes or refreshes this process's row. */
  heartbeat(
    identity: BoardProcessIdentity,
    update: BoardProcessPulseUpdate,
    now: Date,
  ): Promise<void>;
  /** Every registered process, oldest start first (stable for the panel). */
  listProcesses(): Promise<BoardProcessRow[]>;
  /** Deletes rows whose last pulse is older than `cutoff`; returns the count. */
  deleteStale(cutoff: Date): Promise<number>;
}

export function createBoardProcessStore(db: Db): BoardProcessStore {
  return {
    async heartbeat(identity, update, now) {
      // Upsert, not insert: the same process refreshes its own row every pulse,
      // and the identity it rewrites (pid, hostname, container, version, port)
      // is exactly what could have changed since the previous one.
      await db
        .insert(boardProcesses)
        .values({
          bootId: identity.bootId,
          role: identity.role,
          pid: identity.pid,
          hostname: identity.hostname,
          container: identity.container,
          version: identity.version,
          startedAt: identity.startedAt,
          lastSeenAt: now,
          apiPort: identity.apiPort,
          eventLoopLagMs: wholeMilliseconds(update.eventLoopLagMs),
          rssBytes: update.rssBytes,
        })
        .onConflictDoUpdate({
          target: boardProcesses.bootId,
          set: {
            role: identity.role,
            pid: identity.pid,
            hostname: identity.hostname,
            container: identity.container,
            version: identity.version,
            lastSeenAt: now,
            apiPort: identity.apiPort,
            eventLoopLagMs: wholeMilliseconds(update.eventLoopLagMs),
            rssBytes: update.rssBytes,
          },
        });
    },

    async listProcesses() {
      const rows = await db
        .select()
        .from(boardProcesses)
        .orderBy(asc(boardProcesses.startedAt), asc(boardProcesses.bootId));
      return rows.map((row) => ({
        bootId: row.bootId,
        role: row.role,
        pid: row.pid,
        hostname: row.hostname,
        container: row.container,
        version: row.version,
        startedAt: row.startedAt,
        lastSeenAt: row.lastSeenAt,
        apiPort: row.apiPort,
        eventLoopLagMs: row.eventLoopLagMs,
        rssBytes: row.rssBytes === null ? null : Number(row.rssBytes),
      }));
    },

    async deleteStale(cutoff) {
      const deleted = await db
        .delete(boardProcesses)
        .where(lt(boardProcesses.lastSeenAt, cutoff))
        .returning({ bootId: boardProcesses.bootId });
      return deleted.length;
    },
  };
}
