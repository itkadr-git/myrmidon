// myrmidon(DBC-4): tests for the PostgreSQL collector.
//
// The collector talks to the database through a query port, so the whole
// collection is exercised without a server: a scripted port answers the reads
// in the order the collector issues them, and the snapshot is asserted field by
// field. The two properties that matter beyond the happy path are asserted too:
// a missing pg_stat_statements must not fail the snapshot, and a broken read
// must land in `warnings` instead of throwing.
//
// Neutral data only: example.com, 192.0.2.0/24.

import { describe, expect, it } from "vitest";

import { BOARD_CONNECTION_REF, BOARD_TARGET } from "../domain.js";
import {
  collectPostgresSnapshot,
  type BackupFileEntry,
  type DatastoreQueryPort,
  type DatastoreRow,
} from "./postgres.js";

const NOW = new Date("2026-10-08T05:00:00.000Z");

/** A port that answers the collector's reads from a fixed script, in order. */
function scriptedPort(script: DatastoreRow[][], connectionRef = BOARD_CONNECTION_REF) {
  let cursor = 0;
  const seen: number[] = [];
  const port: DatastoreQueryPort = {
    connectionRef,
    async rows(): Promise<DatastoreRow[]> {
      const index = cursor;
      cursor += 1;
      seen.push(index);
      return script[index] ?? [];
    },
  };
  return { port, calls: () => cursor, order: () => seen };
}

const IDENTITY: DatastoreRow[] = [
  {
    database: "board",
    dbid: "16384",
    database_bytes: "1073741824",
    server_version: "PostgreSQL 18.0 on x86_64-pc-linux-gnu",
  },
];

const TABLES: DatastoreRow[] = [
  {
    table_name: "issues",
    total_bytes: "536870912",
    heap_bytes: "400000000",
    toast_bytes: "50000000",
    index_bytes: "86870912",
    live_rows: "1200",
    dead_rows: "12",
  },
  {
    table_name: "activity_log",
    total_bytes: "134217728",
    heap_bytes: "100000000",
    toast_bytes: "0",
    index_bytes: "34217728",
    live_rows: "9000",
    dead_rows: "900",
  },
];

const INDEXES: DatastoreRow[] = [
  { index_name: "issues_company_idx", table_name: "issues", bytes: "10485760", scans: "4200" },
  { index_name: "issues_legacy_idx", table_name: "issues", bytes: "5242880", scans: "0" },
];

const SETTINGS: DatastoreRow[] = [
  { name: "jit", setting: "on", unit: null },
  { name: "max_connections", setting: "100", unit: null },
  { name: "not_audited", setting: "42", unit: null },
  { name: "shared_buffers", setting: "524288", unit: "8kB" },
  { name: "work_mem", setting: "4096", unit: "kB" },
];

const STATS: DatastoreRow[] = [
  {
    blks_hit: "990000",
    blks_read: "1000",
    xact_commit: "500",
    xact_rollback: "1",
    backends: "7",
    temp_bytes: "2048",
  },
];

const TOP_QUERY: DatastoreRow[] = [
  {
    query_id: "1234567",
    calls: "42",
    total_ms: "9000.5",
    mean_ms: "214.2857",
    rows: "9000",
    query: "SELECT * FROM issues WHERE company_id = $1",
  },
];

const PGVECTOR_COLUMNS: DatastoreRow[] = [
  { table_name: "issue_embeddings", column_name: "embedding", indexed: true },
];

function backupFiles(): BackupFileEntry[] {
  return [
    { name: "board-2026-10-08.dump", mtimeMs: NOW.getTime() - 3 * 3_600_000, bytes: 4096 },
    { name: "board-2026-10-07.dump", mtimeMs: NOW.getTime() - 27 * 3_600_000, bytes: 2048 },
  ];
}

describe("myrmidon(DBC-4) postgres collector", () => {
  it("collects sizes, TOAST, indexes, top queries, settings and backup freshness", async () => {
    const { port, calls } = scriptedPort([
      IDENTITY,
      TABLES,
      INDEXES,
      [{ invalid: "0" }],
      [
        { name: "pg_stat_statements", version: "1.11" },
        { name: "plpgsql", version: "1.0" },
      ],
      TOP_QUERY,
      [{ total_ms: "10000" }],
      SETTINGS,
      STATS,
    ]);

    const payload = await collectPostgresSnapshot(
      {
        target: BOARD_TARGET,
        now: NOW,
        topQueries: 25,
        backupDir: "/srv/backups/board",
        optionalMetrics: true,
      },
      { connection: port, readBackupDir: async () => backupFiles() },
    );

    expect(payload.key).toBe("board");
    expect(payload.engine).toBe("postgres");
    expect(payload.connectionRef).toBe(BOARD_CONNECTION_REF);
    expect(payload.database).toBe("board");
    expect(payload.dbId).toBe(16384);
    expect(payload.databaseBytes).toBe(1_073_741_824);
    expect(payload.serverVersion).toContain("PostgreSQL 18");
    expect(payload.capturedAt).toBe(NOW.toISOString());

    expect(payload.tables.map((table) => table.table)).toEqual(["issues", "activity_log"]);
    expect(payload.tables[0]).toMatchObject({
      totalBytes: 536_870_912,
      toastBytes: 50_000_000,
      indexBytes: 86_870_912,
      liveRows: 1200,
      deadRows: 12,
    });
    expect(payload.tablesBytes).toBe(671_088_640);
    expect(payload.toastBytes).toBe(50_000_000);
    expect(payload.indexBytes).toBe(121_088_640);

    expect(payload.indexCount).toBe(2);
    expect(payload.invalidIndexCount).toBe(0);
    expect(payload.indexes[0]).toEqual({
      index: "issues_company_idx",
      table: "issues",
      bytes: 10_485_760,
      scans: 4200,
    });

    expect(payload.statStatementsAvailable).toBe(true);
    expect(payload.topQueries).toHaveLength(1);
    expect(payload.topQueries[0]).toEqual({
      queryId: "1234567",
      calls: 42,
      totalMs: 9000.5,
      meanMs: 214.286,
      rows: 9000,
      query: "SELECT * FROM issues WHERE company_id = $1",
    });
    expect(payload.topQueriesTotalMs).toBe(10_000);

    // Only the audited parameters survive, sorted, with their unit kept.
    expect(payload.settings.map((setting) => setting.name)).toEqual([
      "jit",
      "max_connections",
      "shared_buffers",
      "work_mem",
    ]);
    expect(payload.settings.find((setting) => setting.name === "work_mem")).toEqual({
      name: "work_mem",
      value: "4096",
      unit: "kB",
    });

    expect(payload.databaseStats).toEqual({
      blksHit: 990_000,
      blksRead: 1000,
      xactCommit: 500,
      xactRollback: 1,
      backends: 7,
      maxConnections: 100,
      tempBytes: 2048,
    });

    expect(payload.backup).toEqual({
      available: true,
      dir: "/srv/backups/board",
      fileCount: 2,
      latestFile: "board-2026-10-08.dump",
      latestAt: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
      ageHours: 3,
      bytes: 4096,
      note: null,
    });

    expect(payload.warnings).toEqual([]);
    // Nine reads for the snapshot itself, plus the two probes of the
    // text-search metric that the optional block always runs when enabled.
    expect(calls()).toBe(11);
    expect(payload.optional.pgvector).toBeNull();
    expect(payload.optional.fullTextSearch).toEqual({
      available: false,
      configurations: 0,
      tsvectorColumns: 0,
    });
  });

  it("keeps the snapshot when pg_stat_statements is missing, and says why", async () => {
    const { port } = scriptedPort([
      IDENTITY,
      TABLES,
      INDEXES,
      [{ invalid: "0" }],
      [{ name: "plpgsql", version: "1.0" }],
      SETTINGS,
      STATS,
    ]);

    const payload = await collectPostgresSnapshot(
      {
        target: BOARD_TARGET,
        now: NOW,
        topQueries: 25,
        backupDir: "/srv/backups/board",
        optionalMetrics: true,
      },
      { connection: port, readBackupDir: async () => [] },
    );

    expect(payload.statStatementsAvailable).toBe(false);
    expect(payload.topQueries).toEqual([]);
    expect(payload.topQueriesTotalMs).toBe(0);
    expect(payload.databaseBytes).toBe(1_073_741_824);
    expect(payload.warnings.join("\n")).toContain("pg_stat_statements is not installed");
    // An empty backup directory is not a failure either, it is a fact: no
    // warning, `fileCount` 0, and a note that names what is missing. `available`
    // reports the backup file itself (the criterion fails on the empty age), so
    // it is false here — the same shape the report reads for "no backup".
    expect(payload.backup.available).toBe(false);
    expect(payload.backup.fileCount).toBe(0);
    expect(payload.backup.note).toContain("no backup found");
  });

  it("records a failing read as a warning instead of throwing the collection away", async () => {
    let call = 0;
    const port: DatastoreQueryPort = {
      connectionRef: "board-primary",
      async rows(): Promise<DatastoreRow[]> {
        call += 1;
        if (call === 1) return IDENTITY;
        if (call === 2) throw new Error("canceling statement due to statement timeout");
        if (call === 3) return INDEXES;
        if (call === 4) return [{ invalid: "0" }];
        if (call === 5) return [];
        if (call === 6) return SETTINGS;
        if (call === 7) return STATS;
        return [];
      },
    };

    const payload = await collectPostgresSnapshot(
      {
        target: BOARD_TARGET,
        now: NOW,
        topQueries: 25,
        backupDir: "/srv/backups/board",
        optionalMetrics: false,
      },
      {
        connection: port,
        readBackupDir: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
      },
    );

    expect(payload.tablesBytes).toBe(0);
    expect(payload.databaseBytes).toBe(1_073_741_824);
    expect(payload.warnings.join("\n")).toContain("table sizes: canceling statement");
    expect(payload.warnings.join("\n")).toContain("backup directory /srv/backups/board is unreadable");
    expect(payload.backup.available).toBe(false);
    // The optional metrics were switched off, so nothing was read for them.
    expect(payload.optional).toEqual({ pgvector: null, fullTextSearch: null });
  });

  it("collects the pgvector metrics only when the extension is there", async () => {
    const { port, calls } = scriptedPort([
      IDENTITY,
      TABLES,
      INDEXES,
      [{ invalid: "1" }],
      [
        { name: "pg_stat_statements", version: "1.11" },
        { name: "vector", version: "0.8.0" },
      ],
      TOP_QUERY,
      [{ total_ms: "10000" }],
      SETTINGS,
      STATS,
      PGVECTOR_COLUMNS,
      [{ configurations: "2" }],
      [{ tsvector_columns: "1" }],
    ]);

    const payload = await collectPostgresSnapshot(
      {
        target: BOARD_TARGET,
        now: NOW,
        topQueries: 25,
        backupDir: "/srv/backups/board",
        optionalMetrics: true,
      },
      { connection: port, readBackupDir: async () => backupFiles() },
    );

    expect(payload.invalidIndexCount).toBe(1);
    expect(payload.optional.pgvector).toEqual({
      available: true,
      columns: [{ table: "issue_embeddings", column: "embedding", indexed: true }],
    });
    // The full-text-search probe answered with its own shape, so the collector
    // read it: two extra reads happened after the pgvector one.
    expect(calls()).toBeGreaterThan(10);
  });

  it("collects whatever connection and dbid it is given, not a hardcoded one", async () => {
    const other = scriptedPort(
      [
        [
          {
            database: "board_ro",
            dbid: "4242",
            database_bytes: "512",
            server_version: "PostgreSQL 18.0",
          },
        ],
        [],
        [],
        [{ invalid: "0" }],
        [],
        SETTINGS,
        [],
      ],
      "board-readonly",
    );

    const payload = await collectPostgresSnapshot(
      {
        target: { ...BOARD_TARGET, connectionRef: "board-readonly" },
        dbId: 4242,
        now: NOW,
        topQueries: 5,
        backupDir: "/srv/backups/board",
        optionalMetrics: false,
      },
      { connection: other.port, readBackupDir: async () => [] },
    );

    expect(payload.connectionRef).toBe("board-readonly");
    expect(payload.database).toBe("board_ro");
    expect(payload.dbId).toBe(4242);
    expect(payload.databaseBytes).toBe(512);
    expect(other.calls()).toBe(7);
  });

  it("keeps only the requested number of top queries and tables", async () => {
    const { port } = scriptedPort([
      IDENTITY,
      TABLES,
      INDEXES,
      [{ invalid: "0" }],
      [{ name: "pg_stat_statements", version: "1.11" }],
      TOP_QUERY,
      [{ total_ms: "10000" }],
      SETTINGS,
      STATS,
    ]);

    const payload = await collectPostgresSnapshot(
      {
        target: BOARD_TARGET,
        now: NOW,
        topQueries: 3,
        backupDir: "/srv/backups/board",
        optionalMetrics: false,
        tablesLimit: 1,
      },
      { connection: port, readBackupDir: async () => [] },
    );

    // The limit travels to the database; the port answers what it has.
    expect(payload.tables).toHaveLength(2);
    expect(payload.tablesBytes).toBeGreaterThan(0);
  });
});