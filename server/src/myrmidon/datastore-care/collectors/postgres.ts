// server/src/myrmidon/datastore-care/collectors/postgres.ts
//
// myrmidon(DBC-4): the PostgreSQL collector.
//
// It is parameterised by the connection port and by `dbId` (the
// `pg_database.oid` of the database to collect) from the first day, so DBC-5
// only has to add targets: the board's database is just the implicit target
// whose `dbId` is resolved from the connection's `current_database()`.
//
// Every step is individually forgiving: a missing pg_stat_statements, a table
// without TOAST, an unreadable backup directory must not lose the rest of the
// snapshot — the failure is recorded in `warnings` and in the field it belongs
// to. Nothing here writes to the collected database: the collector only reads
// (and reads the backup directory on disk).

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import type {
  DatastoreBackupMetric,
  DatastoreCollectedSnapshot,
  DatastoreIndexMetric,
  DatastoreOptionalMetrics,
  DatastoreSettingMetric,
  DatastoreTableMetric,
  DatastoreTarget,
  DatastoreTopQueryMetric,
} from "../domain.js";

/** A row as the driver returns it. */
export type DatastoreRow = Record<string, unknown>;

/** One read-only query port: the connection the target is collected through. */
export interface DatastoreQueryPort {
  /** Logical name of the connection, stored in the snapshot. */
  readonly connectionRef: string;
  rows(query: SQL): Promise<DatastoreRow[]>;
}

/** Builds the query port of the board's own connection. */
export function drizzleQueryPort(db: Db, connectionRef: string): DatastoreQueryPort {
  return {
    connectionRef,
    async rows(query: SQL): Promise<DatastoreRow[]> {
      const result = await db.execute(query);
      return Array.isArray(result) ? (result as unknown as DatastoreRow[]) : [];
    },
  };
}

/** One file of the backup directory. */
export interface BackupFileEntry {
  name: string;
  mtimeMs: number;
  bytes: number;
}

/** Ports the collector needs; the file-system one is replaceable in tests. */
export interface PostgresCollectorPorts {
  connection: DatastoreQueryPort;
  readBackupDir?: (dir: string) => Promise<BackupFileEntry[]>;
}

/** What one collection of one target needs. */
export interface PostgresCollectionInput {
  target: DatastoreTarget;
  /** `pg_database.oid` to collect; null = the connection's current database. */
  dbId?: number | null;
  now: Date;
  /** How many rows of pg_stat_statements the snapshot keeps. */
  topQueries: number;
  /** Directory the board writes its database backups to. */
  backupDir: string;
  /** Whether the extension-gated metrics are collected. */
  optionalMetrics: boolean;
  /** How many tables the snapshot keeps (largest first). */
  tablesLimit?: number;
}

/** Number of tables kept in the snapshot (largest first). */
export const DEFAULT_TABLES_LIMIT = 25;

/** Server parameters the audit criteria read; collected unfiltered, sliced here. */
export const AUDITED_SETTINGS = [
  "shared_buffers",
  "work_mem",
  "maintenance_work_mem",
  "effective_cache_size",
  "max_connections",
  "random_page_cost",
  "jit",
  "jit_above_cost",
  "checkpoint_timeout",
  "max_wal_size",
  "min_wal_size",
  "wal_compression",
  "autovacuum_naptime",
  "autovacuum_vacuum_scale_factor",
  "autovacuum_analyze_scale_factor",
  "default_statistics_target",
  "max_parallel_workers_per_gather",
  "temp_file_limit",
  "log_min_duration_statement",
] as const;

/** Turns whatever the driver returned (string for bigint) into a number. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** Turns whatever the driver returned into a string. */
export function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

/** Reads the backup directory: every file with its mtime and size. */
async function readBackupDirectory(dir: string): Promise<BackupFileEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: BackupFileEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const info = await stat(full);
      files.push({ name: entry.name, mtimeMs: info.mtimeMs, bytes: info.size });
    } catch {
      // A file that vanished between readdir and stat is not interesting.
    }
  }
  return files;
}

/** Collects the backup freshness metric; never throws. */
async function collectBackup(
  dir: string,
  now: Date,
  readDir: (dir: string) => Promise<BackupFileEntry[]>,
  warnings: string[],
): Promise<DatastoreBackupMetric> {
  try {
    const files = await readDir(dir);
    if (files.length === 0) {
      return {
        available: false,
        dir,
        fileCount: 0,
        latestFile: null,
        latestAt: null,
        ageHours: null,
        bytes: null,
        note: "directory is empty — no backup found",
      };
    }
    const latest = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const ageHours = (now.getTime() - latest.mtimeMs) / 3_600_000;
    return {
      available: true,
      dir,
      fileCount: files.length,
      latestFile: latest.name,
      latestAt: new Date(latest.mtimeMs).toISOString(),
      ageHours: Number(ageHours.toFixed(2)),
      bytes: latest.bytes,
      note: null,
    };
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    warnings.push(`backup directory ${dir} is unreadable: ${note}`);
    return {
      available: false,
      dir,
      fileCount: 0,
      latestFile: null,
      latestAt: null,
      ageHours: null,
      bytes: null,
      note,
    };
  }
}

/** Runs one query and records a warning instead of failing the snapshot. */
async function tryRows(
  port: DatastoreQueryPort,
  query: SQL,
  label: string,
  warnings: string[],
): Promise<DatastoreRow[]> {
  try {
    return await port.rows(query);
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    warnings.push(`${label}: ${note}`);
    return [];
  }
}

/** Reads the optional extension-gated metrics (pgvector, full-text search). */
async function collectOptional(
  port: DatastoreQueryPort,
  extensions: { name: string; version: string }[],
  enabled: boolean,
  warnings: string[],
): Promise<DatastoreOptionalMetrics> {
  const empty: DatastoreOptionalMetrics = { pgvector: null, fullTextSearch: null };
  if (!enabled) return empty;

  const names = new Set(extensions.map((extension) => extension.name));

  if (names.has("vector")) {
    const rows = await tryRows(
      port,
      sql`
        SELECT c.relname AS table_name, a.attname AS column_name,
               EXISTS (
                 SELECT 1 FROM pg_index i
                 WHERE i.indrelid = c.oid AND a.attnum = ANY (i.indkey)
               ) AS indexed
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_type t ON t.oid = a.atttypid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE t.typname = 'vector'
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY c.relname, a.attname
      `,
      "pgvector columns",
      warnings,
    );
    empty.pgvector = {
      available: true,
      columns: rows.map((row) => ({
        table: toStringValue(row.table_name),
        column: toStringValue(row.column_name),
        indexed: row.indexed === true || row.indexed === "t",
      })),
    };
  }

  const tsvector = await tryRows(
    port,
    sql`
      SELECT count(*) AS columns
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.typname = 'tsvector'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    `,
    "tsvector columns",
    warnings,
  );
  const configs = await tryRows(
    port,
    sql`SELECT count(*) AS configs FROM pg_ts_config`,
    "text-search configurations",
    warnings,
  );
  const tsvectorColumns = toNumber(tsvector[0]?.columns);
  const configurations = toNumber(configs[0]?.configs);
  empty.fullTextSearch = {
    available: names.has("pg_trgm") || tsvectorColumns > 0 || configurations > 0,
    configurations,
    tsvectorColumns,
  };

  return empty;
}

/**
 * Collects one snapshot of one PostgreSQL target.
 *
 * Reads only: `pg_database_size`, `pg_class`/`pg_stat_user_tables`,
 * `pg_stat_user_indexes`, `pg_index`, `pg_settings`, `pg_stat_database`,
 * `pg_extension` and (when present) `pg_stat_statements`.
 */
export async function collectPostgresSnapshot(
  input: PostgresCollectionInput,
  ports: PostgresCollectorPorts,
): Promise<DatastoreCollectedSnapshot> {
  const { target, now } = input;
  const warnings: string[] = [];
  const port = ports.connection;
  const readDir = ports.readBackupDir ?? readBackupDirectory;
  const tablesLimit = input.tablesLimit ?? DEFAULT_TABLES_LIMIT;
  const dbId = input.dbId ?? null;

  // 1. Identity and the database size the acceptance criteria compare with
  //    pg_database_size (±1 %).
  const identity = await tryRows(
    port,
    sql`
      SELECT d.datname AS database,
             d.oid::bigint AS dbid,
             pg_database_size(d.oid) AS database_bytes,
             version() AS server_version
      FROM pg_database d
      WHERE d.oid = COALESCE(
        ${dbId}::oid,
        (SELECT oid FROM pg_database WHERE datname = current_database())
      )
    `,
    "database identity",
    warnings,
  );
  const identityRow = identity[0] ?? {};
  const database = toStringValue(identityRow.database, "unknown");
  const resolvedDbId = identity.length > 0 ? toNumber(identityRow.dbid, 0) : null;
  const databaseBytes = toNumber(identityRow.database_bytes);
  const serverVersion = toStringValue(identityRow.server_version);

  // 2. Tables: sizes, TOAST, indexes, live/dead rows.
  const tableRows = await tryRows(
    port,
    sql`
      SELECT c.relname AS table_name,
             pg_total_relation_size(c.oid) AS total_bytes,
             pg_relation_size(c.oid) AS heap_bytes,
             CASE WHEN c.reltoastrelid = 0 THEN 0
                  ELSE pg_total_relation_size(c.reltoastrelid) END AS toast_bytes,
             pg_indexes_size(c.oid) AS index_bytes,
             COALESCE(s.n_live_tup, 0) AS live_rows,
             COALESCE(s.n_dead_tup, 0) AS dead_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT ${tablesLimit}
    `,
    "table sizes",
    warnings,
  );
  const tables: DatastoreTableMetric[] = tableRows.map((row) => ({
    table: toStringValue(row.table_name),
    totalBytes: toNumber(row.total_bytes),
    heapBytes: toNumber(row.heap_bytes),
    toastBytes: toNumber(row.toast_bytes),
    indexBytes: toNumber(row.index_bytes),
    liveRows: toNumber(row.live_rows),
    deadRows: toNumber(row.dead_rows),
  }));

  // 3. Indexes with their scan counters (unused-index criterion).
  const indexRows = await tryRows(
    port,
    sql`
      SELECT indexrelname AS index_name,
             relname AS table_name,
             pg_relation_size(indexrelid) AS bytes,
             COALESCE(idx_scan, 0) AS scans
      FROM pg_stat_user_indexes
      ORDER BY pg_relation_size(indexrelid) DESC
    `,
    "index sizes",
    warnings,
  );
  const indexes: DatastoreIndexMetric[] = indexRows.map((row) => ({
    index: toStringValue(row.index_name),
    table: toStringValue(row.table_name),
    bytes: toNumber(row.bytes),
    scans: toNumber(row.scans),
  }));

  const invalidRows = await tryRows(
    port,
    sql`SELECT count(*) AS invalid FROM pg_index WHERE NOT indisvalid`,
    "invalid indexes",
    warnings,
  );
  const invalidIndexCount = toNumber(invalidRows[0]?.invalid);

  // 4. pg_stat_statements (optional: without the extension there are no top
  //    queries, and the report says so instead of failing).
  const extensionRows = await tryRows(
    port,
    sql`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY extname`,
    "extensions",
    warnings,
  );
  const extensions = extensionRows.map((row) => ({
    name: toStringValue(row.name),
    version: toStringValue(row.version),
  }));
  const hasStatStatements = extensions.some((extension) => extension.name === "pg_stat_statements");

  let topQueries: DatastoreTopQueryMetric[] = [];
  let topQueriesTotalMs = 0;
  if (hasStatStatements) {
    const queryRows = await tryRows(
      port,
      sql`
        SELECT queryid::text AS query_id,
               calls,
               total_exec_time AS total_ms,
               mean_exec_time AS mean_ms,
               rows,
               query
        FROM pg_stat_statements
        ORDER BY total_exec_time DESC
        LIMIT ${input.topQueries}
      `,
      "top queries",
      warnings,
    );
    topQueries = queryRows.map((row) => ({
      queryId: toStringValue(row.query_id),
      calls: toNumber(row.calls),
      totalMs: Math.round(toNumber(row.total_ms) * 1000) / 1000,
      meanMs: Math.round(toNumber(row.mean_ms) * 1000) / 1000,
      rows: toNumber(row.rows),
      query: toStringValue(row.query),
    }));
    const totalRows = await tryRows(
      port,
      sql`SELECT COALESCE(sum(total_exec_time), 0) AS total_ms FROM pg_stat_statements`,
      "total statement time",
      warnings,
    );
    topQueriesTotalMs = Math.round(toNumber(totalRows[0]?.total_ms) * 1000) / 1000;
  } else {
    warnings.push(
      "pg_stat_statements is not installed in this database: the snapshot has no top queries",
    );
  }

  // 5. Server parameters the criteria read.
  const settingRows = await tryRows(
    port,
    sql`SELECT name, setting, unit FROM pg_settings`,
    "server settings",
    warnings,
  );
  const audited = new Set<string>(AUDITED_SETTINGS);
  const settings: DatastoreSettingMetric[] = settingRows
    .map((row) => ({
      name: toStringValue(row.name),
      value: toStringValue(row.setting),
      unit: row.unit === null || row.unit === undefined ? null : toStringValue(row.unit),
    }))
    .filter((setting) => audited.has(setting.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 6. Cumulative counters of the collected database.
  const statsRows = await tryRows(
    port,
    sql`
      SELECT COALESCE(blks_hit, 0) AS blks_hit,
             COALESCE(blks_read, 0) AS blks_read,
             COALESCE(xact_commit, 0) AS xact_commit,
             COALESCE(xact_rollback, 0) AS xact_rollback,
             COALESCE(numbackends, 0) AS backends,
             COALESCE(temp_bytes, 0) AS temp_bytes
      FROM pg_stat_database
      WHERE datname = current_database()
    `,
    "database statistics",
    warnings,
  );
  const stats = statsRows[0] ?? {};
  const maxConnections =
    toNumber(settings.find((setting) => setting.name === "max_connections")?.value, 100) || 100;

  // Index aggregates for the stored snapshot; the list itself stays in memory
  // for the report and is dropped by `toStoredSnapshotPayload`.
  const unusedIndexes = indexes.filter((index) => index.scans === 0);
  const unusedIndexBytes = unusedIndexes.reduce((sum, index) => sum + index.bytes, 0);
  // Rows arrive ordered by size DESC, so the first unused one is the largest.
  const largestUnusedIndex = unusedIndexes[0]?.index ?? null;

  const backup = await collectBackup(input.backupDir, now, readDir, warnings);
  const optional = await collectOptional(port, extensions, input.optionalMetrics, warnings);

  return {
    key: target.key,
    engine: target.engine,
    connectionRef: port.connectionRef,
    database,
    dbId: resolvedDbId,
    serverVersion,
    capturedAt: now.toISOString(),
    databaseBytes,
    tablesBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    toastBytes: tables.reduce((sum, table) => sum + table.toastBytes, 0),
    indexBytes: tables.reduce((sum, table) => sum + table.indexBytes, 0),
    tables,
    indexes,
    indexCount: indexes.length,
    invalidIndexCount,
    unusedIndexCount: unusedIndexes.length,
    unusedIndexBytes,
    largestUnusedIndex,
    topQueries,
    topQueriesTotalMs,
    statStatementsAvailable: hasStatStatements,
    settings,
    extensions,
    databaseStats: {
      blksHit: toNumber(stats.blks_hit),
      blksRead: toNumber(stats.blks_read),
      xactCommit: toNumber(stats.xact_commit),
      xactRollback: toNumber(stats.xact_rollback),
      backends: toNumber(stats.backends),
      maxConnections,
      tempBytes: toNumber(stats.temp_bytes),
    },
    backup,
    optional,
    warnings,
  };
}