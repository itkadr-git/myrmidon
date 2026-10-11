// packages/db/src/schema/board_processes.ts
//
// myrmidon(1.6.6 PROCS-0.1, design BOARD-PROCESSES §5.1): the process registry
// of the board — one row per running board process, kept fresh by a pulse.
//
// Part of этап 0 of the multi-process project. Today one process owns
// everything (`mode=single`, role `all`), so the table holds a single row; it
// is the substrate the later stages read: which processes exist, with which
// role, how alive they are, and whether the owner of some row is still there
// ("is this applying run's owner in `board_processes` and fresh?"). The panel
// in Instance settings and the alive-check both read these rows instead of
// scraping metrics.
//
// `boot_id` is the primary key — a random UUID per process (design §3: the
// same identity rule as `legacyControllerBootId`), because neither a PID nor a
// hostname survives a container restart and a reused PID would silently
// overwrite a live row. `started_at` is when the process came up,
// `last_seen_at` the last pulse (design §5.1: every 10 s; rows older than
// 2 min are reaped by the leader). `event_loop_lag_ms` and `rss_bytes` carry
// the last pulse's measurements so the panel shows health without a scrape.
// `api_port` is null for a process that serves no HTTP (the worker in the
// split layout) and for a single-process board that has not bound yet.
//
// Additive migration only: one new table plus one index, no vendor table
// touched, no data rewritten.

import { bigint, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const boardProcesses = pgTable(
  "board_processes",
  {
    /** Random UUID per process (design §3); the row identity across restarts. */
    bootId: text("boot_id").primaryKey(),
    /** all | worker | api — the role this process runs (design §2.1). */
    role: text("role").notNull(),
    pid: integer("pid").notNull(),
    hostname: text("hostname").notNull(),
    /** Container name/id when the process runs in one; null on a bare host. */
    container: text("container"),
    /** Board version this process runs, e.g. 1.6.6+0.git.abc1234. */
    version: text("version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Last pulse; rows older than 2 min are stale and reaped by the leader. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** HTTP port this process serves, when it serves one. */
    apiPort: integer("api_port"),
    /** Event loop lag of the pulse window in WHOLE milliseconds. The pulse
     * measures a fraction (nanosecond percentiles of `monitorEventLoopDelay`)
     * and rounds it before writing: this column is int4, like every `*_ms`
     * gauge here, and Postgres rejects a fraction with 22P02 — a failure the
     * pulse would swallow, leaving the panel empty (see the store's rounding
     * boundary). */
    eventLoopLagMs: integer("event_loop_lag_ms"),
    /** Resident set size at the last pulse, bytes. */
    rssBytes: bigint("rss_bytes", { mode: "number" }),
  },
  (table) => ({
    lastSeenIdx: index("board_processes_last_seen_idx").on(table.lastSeenAt),
  }),
);

/**
 * Leader leases of the board (design §5.1/§7.2): one row per named lease
 * (`scheduler`, `backup`, ...). `holder_boot_id` points at the owner's
 * `board_processes.boot_id` (no FK: a reaped process must not block the
 * takeover of its lease), `epoch` grows on every handover (fencing token) and
 * `expires_at` is the TTL deadline. Today the table has no writer — a
 * single-process board holds no lease — and the read route answers an empty
 * list; the lease holder of the later stages writes here.
 */
export const boardLeases = pgTable("board_leases", {
  name: text("name").primaryKey(),
  holderBootId: text("holder_boot_id"),
  epoch: bigint("epoch", { mode: "number" }).notNull().default(0),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
