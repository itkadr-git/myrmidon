// packages/db/src/schema/datastore_care.ts
//
// myrmidon(DBC-4): datastore care — hourly size/metric snapshots and the
// on-demand database audit reports of the board's own PostgreSQL.
//
// Two additive tables, owned by the myrmidon module
// server/src/myrmidon/datastore-care/. Nothing vendor-side is touched:
//
//  * datastore_snapshots holds one row per collected metric set (one per hour
//    per datastore target). The whole collected payload is stored unchanged in
//    `payload` jsonb, while the three numbers the API and the audit report
//    query directly (database size, TOAST size, index size) are lifted into
//    columns so the list endpoint never parses JSON.
//  * datastore_audit_reports holds one row per generated audit report, with the
//    criteria table (section 6 thresholds and their measured values) in
//    `criteria` jsonb and the exported markdown in `markdown`.
//
// Both tables carry their own 90-day retention (settings, see
// server/src/myrmidon/datastore-care/settings.ts); the hourly job prunes them.

import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** One collected metric set of one datastore target at one moment. */
export const datastoreSnapshots = pgTable(
  "datastore_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Target key; the board's own database is the implicit target "board". */
    datastoreKey: text("datastore_key").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    /** pg_database_size(current_database()) — the number the API reports. */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Sum of the TOAST relations of the target's tables. */
    toastBytes: bigint("toast_bytes", { mode: "number" }).notNull().default(0),
    /** Sum of the indexes of the target's tables. */
    indexBytes: bigint("index_bytes", { mode: "number" }).notNull().default(0),
    /** PostgreSQL server version reported in the same collection. */
    serverVersion: text("server_version").notNull().default(""),
    /** The whole collected payload (sizes, TOAST, indexes, top queries, …). */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyCapturedIdx: index("datastore_snapshots_key_captured_idx").on(
      table.datastoreKey,
      table.capturedAt,
    ),
  }),
);

/** One generated audit report: criteria with values plus the .md export. */
export const datastoreAuditReports = pgTable(
  "datastore_audit_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datastoreKey: text("datastore_key").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    /** What asked for the report: `manual` (button) or `hourly` (job). */
    trigger: text("trigger").notNull().default("manual"),
    /** Snapshot the report was computed from (null when none existed yet). */
    snapshotId: uuid("snapshot_id"),
    /** Section-6 criteria with their measured values and verdicts. */
    criteria: jsonb("criteria").$type<Record<string, unknown>[]>().notNull(),
    /** Top queries the report printed (id, calls, total/mean ms, share). */
    topQueries: jsonb("top_queries").$type<Record<string, unknown>[]>().notNull(),
    /** The exported markdown, exactly what the .md download returns. */
    markdown: text("markdown").notNull(),
    /** Short machine-readable summary (verdict counts, total database size). */
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyGeneratedIdx: index("datastore_audit_reports_key_generated_idx").on(
      table.datastoreKey,
      table.generatedAt,
    ),
  }),
);