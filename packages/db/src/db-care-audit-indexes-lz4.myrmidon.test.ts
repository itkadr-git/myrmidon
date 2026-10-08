// myrmidon(DB-CARE / DBC-2): the datastore audit of 07-08.10.2026 created five
// indexes by hand on the production board database and switched three varlena
// columns of heartbeat_runs to the lz4 compression method. Migration 0308
// persists the indexes and migration 0309 the compression methods as managed
// objects. The static half pins both files, the journal entries and the snapshot
// chain and reconciles the SQL predicates with the snapshot declarations (the
// drift check behind `db:generate`); the embedded-Postgres half pins the
// definitions the operator's pg_indexes reconciliation compares against and
// applies both migrations twice on one database to prove idempotency.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEXES_MIGRATION_FILE = "./migrations/0308_db_care_audit_indexes.sql";
const INDEXES_MIGRATION_TAG = "0308_db_care_audit_indexes";
const INDEXES_SNAPSHOT_FILE = "./migrations/meta/0308_snapshot.json";
const COMPRESSION_MIGRATION_FILE = "./migrations/0309_db_care_lz4_compression.sql";
const COMPRESSION_MIGRATION_TAG = "0309_db_care_lz4_compression";
const COMPRESSION_SNAPSHOT_FILE = "./migrations/meta/0309_snapshot.json";
const PREVIOUS_SNAPSHOT_FILE = "./migrations/meta/0307_snapshot.json";

// The six indexes of DBC-2: the five this change persists, keyed by table, plus
// the previous-assignee index that migration 0307 already carries.
const INDEXES = [
  {
    name: "activity_log_issue_last_activity_idx",
    table: "activity_log",
    method: "btree",
    sql: 'CREATE INDEX IF NOT EXISTS "activity_log_issue_last_activity_idx" ON "activity_log" USING btree ("company_id","entity_id","created_at" DESC)',
    predicate: '"entity_type" = \'issue\' and "action" <> ALL (ARRAY[\'issue.read_marked\', \'issue.read_unmarked\', \'issue.inbox_archived\', \'issue.inbox_unarchived\'])',
    snapshotWhere: ["entity_type", "issue", "action", "issue.read_marked", "issue.inbox_unarchived"],
    indexdef: ["company_id", "entity_id", "created_at", "entity_type", "'issue'", "action", "issue.read_marked", "issue.inbox_unarchived"],
  },
  {
    name: "issue_comments_body_lower_trgm_idx",
    table: "issue_comments",
    method: "gin",
    sql: 'CREATE INDEX IF NOT EXISTS "issue_comments_body_lower_trgm_idx" ON "issue_comments" USING gin (lower("body") gin_trgm_ops)',
    predicate: '"deleted_at" is null',
    snapshotWhere: ["deleted_at", "is null"],
    indexdef: ["lower(body)", "gin_trgm_ops", "deleted_at IS NULL"],
  },
  {
    name: "heartbeat_runs_attention_feed_idx",
    table: "heartbeat_runs",
    method: "btree",
    sql: 'CREATE INDEX IF NOT EXISTS "heartbeat_runs_attention_feed_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at",("context_snapshot" ->> \'issueId\'),("context_snapshot" ->> \'taskId\'))',
    predicate: null,
    snapshotWhere: [],
    indexdef: ["company_id", "agent_id", "created_at", "issueId", "taskId"],
  },
  {
    name: "heartbeat_runs_ctx_paperclip_issue_id_idx",
    table: "heartbeat_runs",
    method: "btree",
    sql: 'CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_paperclip_issue_id_idx" ON "heartbeat_runs" USING btree ("company_id",(("context_snapshot" -> \'paperclipIssue\') ->> \'id\'))',
    predicate: '"context_snapshot" ? \'paperclipIssue\'',
    snapshotWhere: ["context_snapshot", "paperclipIssue"],
    indexdef: ["company_id", "paperclipIssue", "id"],
  },
  {
    name: "heartbeat_runs_updated_at_idx",
    table: "heartbeat_runs",
    method: "btree",
    sql: 'CREATE INDEX IF NOT EXISTS "heartbeat_runs_updated_at_idx" ON "heartbeat_runs" USING btree ("updated_at")',
    predicate: null,
    snapshotWhere: [],
    indexdef: ["updated_at"],
  },
] as const;

// The three varlena columns of heartbeat_runs the audit switched to lz4.
const COMPRESSED_COLUMNS = ["context_snapshot", "result_json", "stdout_excerpt"] as const;

function statementsOf(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .map((statement) => {
      // Drop the leading comment block of the migration (and the per-statement
      // safety-ignore notes) so the assertions compare statements only.
      const lines = statement.split("\n").filter((line) => !line.trimStart().startsWith("--"));
      return lines.join("\n").trim();
    });
}

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("db-care audit indexes and lz4 migration (static checks)", () => {
  it("declares each CREATE INDEX IF NOT EXISTS statement verbatim", async () => {
    const migrationSql = await readFile(
      fileURLToPath(new URL(INDEXES_MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = statementsOf(migrationSql);
    expect(statements).toHaveLength(INDEXES.length);
    for (const index of INDEXES) {
      const statement = statements.find((candidate) => candidate.includes(index.name));
      expect(statement, `statement for ${index.name}`).toBeDefined();
      expect(statement).toContain(index.sql);
      expect(statement).toContain(`USING ${index.method}`);
      if (index.predicate === null) {
        // A full index has no WHERE clause at all.
        expect(statement).not.toMatch(/ WHERE /);
      } else {
        expect(statement).toContain(`WHERE ${index.predicate}`);
      }
    }
    // The production indexes exist already: they must be re-created
    // idempotently on the next deploy, hence IF NOT EXISTS and no DROP.
    expect(migrationSql).not.toContain("DROP INDEX");
    expect(migrationSql).not.toContain("CREATE UNIQUE INDEX");
    // The two indexes on "large" tables carry the guard note the migration
    // safety checker asks for, because a migration cannot use CONCURRENTLY.
    expect(
      migrationSql.split("migration-safety-ignore large-create-index-not-concurrently"),
    ).toHaveLength(3);
  });

  it("declares the three SET COMPRESSION lz4 statements and no schema object", async () => {
    const migrationSql = await readFile(
      fileURLToPath(new URL(COMPRESSION_MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = statementsOf(migrationSql);
    expect(statements).toHaveLength(COMPRESSED_COLUMNS.length);
    for (const column of COMPRESSED_COLUMNS) {
      expect(statements).toContain(
        `ALTER TABLE "heartbeat_runs" ALTER COLUMN "${column}" SET COMPRESSION lz4;`,
      );
    }
    expect(migrationSql).not.toContain("DROP");
    expect(migrationSql).not.toContain("UPDATE");
  });

  it("registers both migrations in the journal and chains the snapshots", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const indexesEntry = journal.entries.find((entry) => entry.idx === 308);
    const compressionEntry = journal.entries.find((entry) => entry.idx === 309);
    expect(indexesEntry?.tag).toBe(INDEXES_MIGRATION_TAG);
    expect(compressionEntry?.tag).toBe(COMPRESSION_MIGRATION_TAG);
    // Both entries follow the 0307 entry that carries the same batch.
    const previousEntry = journal.entries.find((entry) => entry.idx === 307);
    expect(indexesEntry?.when).toBeGreaterThan(previousEntry?.when ?? 0);
    expect(compressionEntry?.when).toBeGreaterThan(indexesEntry?.when ?? 0);

    const previous = JSON.parse(
      await readFile(fileURLToPath(new URL(PREVIOUS_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as { id: string };
    const indexesSnapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(INDEXES_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as Snapshot;
    const compressionSnapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(COMPRESSION_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as Snapshot;
    expect(indexesSnapshot.prevId).toBe(previous.id);
    expect(indexesSnapshot.id).not.toBe(previous.id);
    expect(compressionSnapshot.prevId).toBe(indexesSnapshot.id);
    expect(compressionSnapshot.id).not.toBe(indexesSnapshot.id);
  });

  it("reconciles the SQL predicates with the snapshot declarations", async () => {
    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(INDEXES_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as Snapshot;
    const compressionSnapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(COMPRESSION_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as Snapshot;
    for (const index of INDEXES) {
      const declaration = snapshot.tables[`public.${index.table}`].indexes[index.name];
      expect(declaration, `snapshot entry for ${index.name}`).toBeDefined();
      expect(declaration.name).toBe(index.name);
      expect(declaration.method).toBe(index.method);
      expect(declaration.isUnique).toBe(false);
      expect(declaration.concurrently).toBe(false);
      const where = declaration.where?.replaceAll('"', "") ?? "";
      for (const fragment of index.snapshotWhere) {
        expect(where).toContain(fragment);
      }
      if (index.snapshotWhere.length === 0) {
        expect(declaration.where).toBeUndefined();
      }
    }
    // The previous-assignee index of 0307 stays untouched by both migrations.
    expect(
      snapshot.tables["public.activity_log"].indexes.activity_log_issue_prev_assignee_idx,
    ).toBeDefined();
    // A SET COMPRESSION statement changes no schema object, so the compression
    // snapshot differs from the indexes snapshot by its identity only, and the
    // drift check behind `db:generate` stays clean.
    const identityOnly = (candidate: Snapshot) => ({
      ...candidate,
      id: "id",
      prevId: "prevId",
    });
    expect(identityOnly(compressionSnapshot)).toEqual(identityOnly(snapshot));
  });
});

type SnapshotIndex = {
  name: string;
  columns: Array<{ expression: string; isExpression?: boolean; asc: boolean }>;
  isUnique: boolean;
  concurrently: boolean;
  method: string;
  where?: string;
};

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { indexes: Record<string, SnapshotIndex> }>;
};

d("db-care audit indexes and lz4 migration (embedded postgres)", () => {
  it("creates the five expected index definitions on a fresh chain", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-audit-indexes-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    for (const index of INDEXES) {
      const rows = await sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = ${index.table} AND indexname = ${index.name}
      `;
      expect(rows.length, `${index.name} exists once`).toBe(1);
      const indexdef = String(rows[0].indexdef);
      expect(indexdef).toContain(index.name);
      expect(indexdef).toContain(`USING ${index.method}`);
      for (const fragment of index.indexdef) {
        expect(indexdef, `${index.name} contains ${fragment}`).toContain(fragment);
      }
    }
  }, 240_000);

  it("applies both migrations twice on one database without errors (idempotency)", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-audit-indexes-idem-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const files = [INDEXES_MIGRATION_FILE, COMPRESSION_MIGRATION_FILE];
    for (const file of files) {
      const migrationSql = await readFile(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const statements = statementsOf(migrationSql);
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of statements) {
          await sql.unsafe(statement);
        }
      }
    }

    for (const index of INDEXES) {
      const rows = await sql.unsafe(`
        SELECT count(*) AS occurrences
        FROM pg_indexes
        WHERE tablename = '${index.table}' AND indexname = '${index.name}'
      `);
      expect(Number(rows[0].occurrences), `${index.name} occurrences`).toBe(1);
    }
  }, 240_000);

  it("sets the lz4 compression method on the three heartbeat_runs columns", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-lz4-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const rows = await sql`
      SELECT a.attname, a.attcompression
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'heartbeat_runs' AND a.attname IN ${sql(COMPRESSED_COLUMNS)}
      ORDER BY a.attname
    `;
    expect(rows).toHaveLength(COMPRESSED_COLUMNS.length);
    for (const row of rows) {
      // attcompression: 'l' is lz4, 'p' is pglz and '' is the server default.
      expect(String(row.attcompression), `${String(row.attname)} compression`).toBe("l");
    }
  }, 240_000);
});