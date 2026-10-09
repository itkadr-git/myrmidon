import { pgTable, uuid, text, integer, bigint, timestamp, index } from "drizzle-orm/pg-core";

/**
 * myrmidon(PROCS-0.1): the board-process registry (OPE-5394 §5.1, этап 0).
 *
 * One row is one live board process. The row appears at boot (insert) and is
 * re-pulsed every `PULSE_INTERVAL_MS` by its own process — `last_seen_at`,
 * `event_loop_lag_ms`, and `rss_bytes` are the moving parts. A process that
 * dies without a clean shutdown leaves a stale row; rows past
 * `STALE_AFTER_MS` are deleted by whichever process wins the cleanup turn.
 *
 * `boot_id` is the primary key: a restarted process is a NEW boot, not the
 * same row updated, so the panel can tell a restart from a live pulse. The
 * table is deliberately NOT per-company — the process registry is an
 * instance surface (Instance settings → Processes), and in single-process
 * mode it holds exactly one row.
 */
export const boardProcesses = pgTable(
  "board_processes",
  {
    bootId: uuid("boot_id").primaryKey(),
    /** Process role of the PROCS profile; "single" until PROCS-1.1 lands. */
    role: text("role").notNull().default("single"),
    pid: integer("pid").notNull(),
    hostname: text("hostname").notNull(),
    /** Container identifier (Docker container id), null outside containers. */
    container: text("container"),
    /** Board version string (serverVersion), for deploy-skew visibility. */
    version: text("version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    apiPort: integer("api_port").notNull(),
    /** Last sampled event-loop p99 delay, milliseconds. */
    eventLoopLagMs: integer("event_loop_lag_ms"),
    rssBytes: bigint("rss_bytes", { mode: "number" }),
  },
  (table) => ({
    lastSeenIdx: index("board_processes_last_seen_idx").on(table.lastSeenAt),
  }),
);

export type BoardProcessRow = typeof boardProcesses.$inferSelect;
export type NewBoardProcessRow = typeof boardProcesses.$inferInsert;
