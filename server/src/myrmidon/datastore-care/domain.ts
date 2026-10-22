// server/src/myrmidon/datastore-care/domain.ts
//
// myrmidon(DBC-4): datastore-care domain — targets, engines and the shape of a
// collected snapshot.
//
// The board's own PostgreSQL is the only target DBC-4 knows: the implicit
// target `board`. It is not configured anywhere — it is derived from the
// connection the board already runs on, which is why the collector takes the
// connection and the `dbid` as parameters from the first day: DBC-5 adds
// targets (ClickHouse read-only) without changing this module.
//
// Engines are exactly `postgres` and `clickhouse-ro`. ES/MySQL/MinIO/Redis are
// deliberately not part of this union: they are not datastores of the board and
// must not leak into the API of the care module.

/** Engines the care module can collect from. */
export type DatastoreEngine = "postgres" | "clickhouse-ro";

/** Key of the implicit target: the database the board itself runs on. */
export const BOARD_DATASTORE_KEY = "board";

/** Logical name of the connection an implicit target is collected through. */
export const BOARD_CONNECTION_REF = "board-primary";

/**
 * A datastore the care module can take snapshots of.
 *
 * `implicit` targets are discovered from the board's own configuration and can
 * never be renamed or removed through the API; `dbId` is the PostgreSQL
 * `pg_database.oid` of the collected database (null until first collected).
 */
export interface DatastoreTarget {
  key: string;
  engine: DatastoreEngine;
  title: string;
  implicit: boolean;
  dbId: number | null;
  connectionRef: string;
}

/** The board's own database. */
export const BOARD_TARGET: DatastoreTarget = {
  key: BOARD_DATASTORE_KEY,
  engine: "postgres",
  title: "Board database (implicit)",
  implicit: true,
  dbId: null,
  connectionRef: BOARD_CONNECTION_REF,
};

/** Targets the care module collects without any configuration. */
export function implicitDatastoreTargets(): readonly DatastoreTarget[] {
  return [BOARD_TARGET];
}

/** Looks a target up by key; keys are matched case-insensitively, trimmed. */
export function findDatastoreTarget(key: string): DatastoreTarget | null {
  const wanted = key.trim().toLowerCase();
  if (!wanted) return null;
  return implicitDatastoreTargets().find((target) => target.key === wanted) ?? null;
}

/** Human-readable byte size, matching the numbers an operator sees in psql. */
export function prettyBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** One table of the target with the sizes the audit report prints. */
export interface DatastoreTableMetric {
  table: string;
  totalBytes: number;
  heapBytes: number;
  toastBytes: number;
  indexBytes: number;
  liveRows: number;
  deadRows: number;
}

/** One index of the target. */
export interface DatastoreIndexMetric {
  index: string;
  table: string;
  bytes: number;
  scans: number;
}

/** One top query as pg_stat_statements reports it. */
export interface DatastoreTopQueryMetric {
  queryId: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  query: string;
}

/** Server parameters the audit criteria look at. */
export interface DatastoreSettingMetric {
  name: string;
  value: string;
  unit: string | null;
}

/** Freshness of the board's database backups, read from the backup directory. */
export interface DatastoreBackupMetric {
  available: boolean;
  dir: string;
  fileCount: number;
  latestFile: string | null;
  latestAt: string | null;
  ageHours: number | null;
  bytes: number | null;
  note: string | null;
}

/** Aggregate counters of `pg_stat_database` for the collected database. */
export interface DatastoreDatabaseStatsMetric {
  blksHit: number;
  blksRead: number;
  xactCommit: number;
  xactRollback: number;
  backends: number;
  maxConnections: number;
  tempBytes: number;
}

/** Optional metrics, only collected when the extension they need is present. */
export interface DatastoreOptionalMetrics {
  pgvector: { available: boolean; columns: { table: string; column: string; indexed: boolean }[] } | null;
  fullTextSearch: { available: boolean; configurations: number; tsvectorColumns: number } | null;
}

/** Everything one snapshot stores. */
export interface DatastoreSnapshotPayload {
  key: string;
  engine: DatastoreEngine;
  connectionRef: string;
  database: string;
  dbId: number | null;
  serverVersion: string;
  capturedAt: string;
  databaseBytes: number;
  /** Sum of `pg_total_relation_size` over the target's tables. */
  tablesBytes: number;
  /** Sum of the tables' TOAST relations. */
  toastBytes: number;
  /** Sum of the tables' indexes (`pg_indexes_size`). */
  indexBytes: number;
  tables: DatastoreTableMetric[];
  /**
   * The indexes of the target as aggregates only. The full list (~1040 rows on
   * the board) is collected in memory for the report and the export — see
   * `DatastoreCollectedSnapshot` — and is deliberately not stored: repeated in
   * every hourly snapshot it would add ~200 MB per target over the 90-day
   * retention, for data nobody reads hourly (operator review 08.10, item 3).
   */
  indexCount: number;
  invalidIndexCount: number;
  /** Indexes with `idx_scan = 0`. */
  unusedIndexCount: number;
  /** Total size of the indexes with `idx_scan = 0`. */
  unusedIndexBytes: number;
  /** Largest unused index by size, or null when every index is used. */
  largestUnusedIndex: string | null;
  topQueries: DatastoreTopQueryMetric[];
  /** Total execution time of every statement in pg_stat_statements (ms). */
  topQueriesTotalMs: number;
  statStatementsAvailable: boolean;
  settings: DatastoreSettingMetric[];
  extensions: { name: string; version: string }[];
  databaseStats: DatastoreDatabaseStatsMetric;
  backup: DatastoreBackupMetric;
  optional: DatastoreOptionalMetrics;
  /** Non-fatal problems of the collection, kept for the report footer. */
  warnings: string[];
}

/**
 * One collection: the stored payload plus the complete index list.
 *
 * The list is what the criteria and the markdown export need at the moment of
 * the collection, and `toStoredSnapshotPayload` drops it before the snapshot is
 * written — the hourly series keeps the aggregates above instead.
 */
export interface DatastoreCollectedSnapshot extends DatastoreSnapshotPayload {
  indexes: DatastoreIndexMetric[];
}

/** Drops the per-index list so only aggregates reach `datastore_snapshots`. */
export function toStoredSnapshotPayload(collected: DatastoreCollectedSnapshot): DatastoreSnapshotPayload {
  const { indexes: _indexes, ...stored } = collected;
  return stored;
}
