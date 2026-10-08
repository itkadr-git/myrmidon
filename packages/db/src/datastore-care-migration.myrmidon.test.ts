// myrmidon(DBC-4): the datastore-care migration — the two tables of the module
// (datastore_snapshots, datastore_audit_reports) with their 90-day retention.
//
// Static checks pin the migration file, the journal entry and the snapshot
// against the drizzle schema, so a later edit of one without the other fails
// here. The embedded-Postgres half proves the columns really accept what the
// collector writes (defaults, jsonb round-trip, the per-key ordering the API
// uses) and that the retention query removes only the old rows.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import { getTableColumns } from "drizzle-orm";
import postgres from "postgres";

import { datastoreAuditReports, datastoreSnapshots } from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0310_datastore_care.sql";
const SNAPSHOT_FILE = "./migrations/meta/0310_snapshot.json";
const PREVIOUS_SNAPSHOT_FILE = "./migrations/meta/0309_snapshot.json";

const SNAPSHOT_COLUMNS = [
  "id",
  "datastore_key",
  "captured_at",
  "size_bytes",
  "toast_bytes",
  "index_bytes",
  "server_version",
  "payload",
  "created_at",
];

const REPORT_COLUMNS = [
  "id",
  "datastore_key",
  "generated_at",
  "trigger",
  "snapshot_id",
  "criteria",
  "top_queries",
  "markdown",
  "summary",
  "created_at",
];

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationSql(): Promise<string> {
  return readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
}

describe("datastore care migration (static checks)", () => {
  it("creates the two tables and their indexes, and touches nothing else", async () => {
    const sql = await migrationSql();
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(4);

    expect(sql).toContain('CREATE TABLE "datastore_snapshots"');
    expect(sql).toContain('CREATE TABLE "datastore_audit_reports"');
    expect(sql).toContain(
      'CREATE INDEX "datastore_snapshots_key_captured_idx" ON "datastore_snapshots" USING btree ("datastore_key","captured_at")',
    );
    expect(sql).toContain(
      'CREATE INDEX "datastore_audit_reports_key_generated_idx" ON "datastore_audit_reports" USING btree ("datastore_key","generated_at")',
    );

    // Additive only: no vendor table is altered, no data is rewritten.
    for (const forbidden of ["ALTER TABLE", "DROP ", "UPDATE ", "DELETE "]) {
      expect(sql).not.toContain(forbidden);
    }
    // The 90-day retention is the module's job, not the migration's.
    expect(sql).toContain("MYRMIDON_DATASTORE_CARE_");
  });

  it("declares exactly the columns of the drizzle schema, in the same order", async () => {
    const sql = await migrationSql();
    const snapshotColumns = Object.values(getTableColumns(datastoreSnapshots)).map(
      (column) => column.name,
    );
    const reportColumns = Object.values(getTableColumns(datastoreAuditReports)).map(
      (column) => column.name,
    );

    expect(snapshotColumns).toEqual(SNAPSHOT_COLUMNS);
    expect(reportColumns).toEqual(REPORT_COLUMNS);
    for (const column of SNAPSHOT_COLUMNS) expect(sql).toContain(`"${column}"`);
    for (const column of REPORT_COLUMNS) expect(sql).toContain(`"${column}"`);

    // The defaults the collector relies on when it writes a row.
    expect(sql).toContain(`"toast_bytes" bigint DEFAULT 0 NOT NULL`);
    expect(sql).toContain(`"index_bytes" bigint DEFAULT 0 NOT NULL`);
    expect(sql).toContain(`"server_version" text DEFAULT '' NOT NULL`);
    expect(sql).toContain(`"trigger" text DEFAULT 'manual' NOT NULL`);
    expect(sql).toContain(`"snapshot_id" uuid`);
    expect(sql).toContain(`"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL`);
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number; breakpoints: boolean }> };
    const entry = journal.entries.find((item) => item.tag === "0310_datastore_care");
    expect(entry).toBeTruthy();
    expect(entry!.idx).toBeGreaterThan(300);
    expect(entry!.when).toBeGreaterThan(1791206402990);
    // The migration is the newest one in the journal.
    expect(journal.entries[journal.entries.length - 1]!.tag).toBe("0310_datastore_care");

    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as {
      id: string;
      prevId: string;
      tables: Record<
        string,
        {
          columns: Record<string, { name: string; type: string; primaryKey: boolean; notNull: boolean }>;
          indexes: Record<string, { name: string; isUnique: boolean; method: string; concurrently: boolean }>;
        }
      >;
    };
    const previous = JSON.parse(
      await readFile(fileURLToPath(new URL(PREVIOUS_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.id).not.toBe(previous.id);

    const snapshotsTable = snapshot.tables["public.datastore_snapshots"];
    const reportsTable = snapshot.tables["public.datastore_audit_reports"];
    expect(Object.keys(snapshotsTable.columns)).toEqual(SNAPSHOT_COLUMNS);
    expect(Object.keys(reportsTable.columns)).toEqual(REPORT_COLUMNS);
    expect(snapshotsTable.columns.size_bytes.type).toBe("bigint");
    expect(snapshotsTable.columns.payload.type).toBe("jsonb");
    expect(snapshotsTable.columns.captured_at.type).toBe("timestamp with time zone");
    expect(snapshotsTable.columns.id.primaryKey).toBe(true);
    expect(reportsTable.columns.generated_at.notNull).toBe(true);
    expect(reportsTable.columns.snapshot_id.notNull).toBe(false);
    expect(reportsTable.columns.snapshot_id.type).toBe("uuid");

    const snapshotIndex = snapshotsTable.indexes["datastore_snapshots_key_captured_idx"];
    expect(snapshotIndex.name).toBe("datastore_snapshots_key_captured_idx");
    expect(snapshotIndex.isUnique).toBe(false);
    expect(snapshotIndex.method).toBe("btree");
    expect(snapshotIndex.concurrently).toBe(false);
    expect(reportsTable.indexes["datastore_audit_reports_key_generated_idx"].name).toBe(
      "datastore_audit_reports_key_generated_idx",
    );
  });
});

d("datastore care migration (embedded postgres)", () => {
  it("accepts what the collector writes and keeps the two tables independent", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("dbc4-store-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const payload = {
      key: "board",
      database: "board",
      databaseBytes: 1_073_741_824,
      topQueries: [{ queryId: "1", calls: 3, totalMs: 1.5 }],
      warnings: [],
    };
    const inserted = await sql`
      INSERT INTO datastore_snapshots (datastore_key, captured_at, size_bytes, payload)
      VALUES ('board', now(), 1073741824, ${sql.json(payload)})
      RETURNING id, toast_bytes, index_bytes, server_version, payload
    `;
    expect(inserted).toHaveLength(1);
    expect(Number(inserted[0]!.toast_bytes)).toBe(0);
    expect(Number(inserted[0]!.index_bytes)).toBe(0);
    expect(inserted[0]!.server_version).toBe("");
    expect(inserted[0]!.payload).toEqual(payload);

    const criteria = [{ id: "db-size", verdict: "ok", value: "1.0 GiB" }];
    const summary = { worst: "warn", ok: 1 };
    const report = await sql`
      INSERT INTO datastore_audit_reports (datastore_key, generated_at, snapshot_id, criteria, top_queries, markdown, summary)
      VALUES ('board', now(), ${inserted[0]!.id}, ${sql.json(criteria)}, ${sql.json(criteria)}, '# Аудит', ${sql.json(summary)})
      RETURNING id, trigger, criteria, summary
    `;
    expect(report[0]!.trigger).toBe("manual");
    expect(report[0]!.criteria).toEqual(criteria);
    expect(report[0]!.summary).toEqual(summary);

    // The per-key ordering the list endpoints use.
    const listed = await sql`
      SELECT id FROM datastore_snapshots WHERE datastore_key = 'board' ORDER BY captured_at DESC LIMIT 24
    `;
    expect(listed).toHaveLength(1);
    const other = await sql`
      SELECT id FROM datastore_snapshots WHERE datastore_key = 'clickhouse-ro' ORDER BY captured_at DESC LIMIT 24
    `;
    expect(other).toHaveLength(0);
  }, 240_000);

  it("prunes only the rows older than the retention window", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("dbc4-retention-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // One snapshot and one report inside the 90-day window, one of each outside.
    await sql.unsafe(`
      INSERT INTO datastore_snapshots (datastore_key, captured_at, size_bytes, payload) VALUES
        ('board', now() - interval '89 days', 1, '{}'::jsonb),
        ('board', now() - interval '91 days', 1, '{}'::jsonb)
    `);
    await sql.unsafe(`
      INSERT INTO datastore_audit_reports (datastore_key, generated_at, criteria, top_queries, markdown, summary) VALUES
        ('board', now() - interval '89 days', '[]'::jsonb, '[]'::jsonb, '# old-ish', '{}'::jsonb),
        ('board', now() - interval '91 days', '[]'::jsonb, '[]'::jsonb, '# old', '{}'::jsonb)
    `);

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const prunedSnapshots = await sql`
      DELETE FROM datastore_snapshots WHERE captured_at < ${cutoff} RETURNING id
    `;
    const prunedReports = await sql`
      DELETE FROM datastore_audit_reports WHERE generated_at < ${cutoff} RETURNING id
    `;
    expect(prunedSnapshots).toHaveLength(1);
    expect(prunedReports).toHaveLength(1);

    const keptSnapshots = await sql`SELECT count(*)::int AS n FROM datastore_snapshots`;
    const keptReports = await sql`SELECT count(*)::int AS n FROM datastore_audit_reports`;
    expect(keptSnapshots[0]!.n).toBe(1);
    expect(keptReports[0]!.n).toBe(1);
  }, 240_000);

  it("reports the size of the board database through pg_database_size", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("dbc4-size-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // The acceptance number of the module: the target size the API reports is
    // the same function the manual audit uses.
    const rows = await sql.unsafe(`
      SELECT d.datname AS database, d.oid::bigint AS dbid, pg_database_size(d.oid) AS database_bytes
      FROM pg_database d
      WHERE d.datname = current_database()
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.database).toBeTruthy();
    expect(Number(rows[0]!.database_bytes)).toBeGreaterThan(0);
    expect(Number(rows[0]!.dbid)).toBeGreaterThan(0);
  }, 240_000);
});