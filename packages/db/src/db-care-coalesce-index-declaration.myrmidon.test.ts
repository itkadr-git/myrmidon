// myrmidon(DB-CARE / DBC-2): the datastore audit of 07-08.10.2026 compared the
// production `pg_indexes` list with the Drizzle declaration and found
// heartbeat_runs_company_issue_coalesce_created_idx on the board database with
// no declaration in src/schema — migration 0302 had created it, but the schema
// never named it. Migration 0312 repeats the 0302 statement and the schema
// declares the index (HeartbeatRuns.companyIssueCoalesceCreatedIdx), so the two
// inventories line up again. The static half pins the migration file, the
// journal entry and the snapshot, and holds the two statements equal to each
// other; the embedded-Postgres half proves the statement is a no-op wherever
// 0302 already ran, and that a fresh chain carries exactly one such index.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "heartbeat_runs_company_issue_coalesce_created_idx";
const MIGRATION_FILE = "./migrations/0312_db_care_coalesce_index_declaration.sql";
const MIGRATION_TAG = "0312_db_care_coalesce_index_declaration";
const SNAPSHOT_FILE = "./migrations/meta/0312_snapshot.json";
const PREVIOUS_SNAPSHOT_FILE = "./migrations/meta/0311_snapshot.json";
// The statement that first created the index; migration 0312 repeats it because
// the schema declaration came later and both halves of the audit must agree.
const DECLARING_MIGRATION_FILE =
  "./migrations/0302_heartbeat_runs_company_issue_coalesce_created_index.sql";
const PREVIOUS_MIGRATION_WHEN = 1791500402000;
const EXPRESSION = "coalesce(\"native_issue_id\"::text, \"context_snapshot\" ->> 'issueId')";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

function statementOf(sqlText: string): string {
  // The comment banners mention CREATE INDEX as prose, so drop comment lines
  // before looking for the statement itself.
  const body = sqlText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const match = body.match(/CREATE INDEX[\s\S]*?;/);
  if (!match) throw new Error("no CREATE INDEX statement found");
  return match[0].replace(/\s+/g, " ").trim();
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("db-care coalesce index declaration (static checks)", () => {
  it("repeats the statement of migration 0302 verbatim", async () => {
    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const declaringSql = await readFile(
      fileURLToPath(new URL(DECLARING_MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statement = statementOf(migrationSql);
    expect(statement).toBe(
      `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "heartbeat_runs" USING btree ("company_id", (${EXPRESSION}), "created_at" DESC, "id" DESC);`,
    );
    // Same four-column managed definition as the original statement: the
    // production copy made by hand during OPE-4106 lacks the trailing
    // `id DESC`, and aligning it is an operator rebuild, not a migration step.
    expect(statement).toBe(statementOf(declaringSql));
    // The index exists on every installation that already ran 0302: this
    // migration must only declare, never rebuild. The comment banner records
    // the operator rebuild (DROP INDEX + CREATE INDEX CONCURRENTLY) as prose;
    // the statement body itself must not drop anything.
    expect(statement).not.toContain("DROP INDEX");
    const banner = migrationSql.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
    expect(banner).toContain(
      "Rebuilding it on production is an operator action (DROP INDEX + CREATE INDEX CONCURRENTLY) and is recorded in docs/",
    );
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 312);
    expect(entry?.tag).toBe(MIGRATION_TAG);
    expect(entry?.when).toBeGreaterThan(PREVIOUS_MIGRATION_WHEN);
    // The declaration is the end of the DB-CARE batch: it follows the lz4 entry.
    expect(journal.entries.at(-1)?.tag).toBe(MIGRATION_TAG);

    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL(SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as {
      id: string;
      prevId: string;
      tables: Record<
        string,
        {
          indexes: Record<
            string,
            {
              name: string;
              columns: Array<{ expression: string; isExpression?: boolean; asc: boolean }>;
              isUnique: boolean;
              concurrently: boolean;
              method: string;
            }
          >;
        }
      >;
    };
    const previous = JSON.parse(
      await readFile(fileURLToPath(new URL(PREVIOUS_SNAPSHOT_FILE, import.meta.url)), "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.id).not.toBe(previous.id);

    const idx = snapshot.tables["public.heartbeat_runs"].indexes[INDEX_NAME];
    expect(idx?.name).toBe(INDEX_NAME);
    expect(idx.method).toBe("btree");
    expect(idx.isUnique).toBe(false);
    expect(idx.concurrently).toBe(false);
    // Four columns, in the order the 0302 statement declares them: the two
    // trailing ones are the `created_at DESC, id DESC` tie-break.
    expect(idx.columns.map((c) => c.asc)).toEqual([true, true, false, false]);
    expect(idx.columns[1].isExpression).toBe(true);
    expect(idx.columns[1].expression).toContain("coalesce");
    expect(idx.columns[1].expression).toContain("native_issue_id");
    expect(idx.columns[1].expression).toContain("issueId");

    // Drift check: the SQL statement and the Drizzle declaration describe the
    // same index, so `db:generate` (schema versus this snapshot) stays clean
    // and the operator's pg_indexes reconciliation has one expected shape.
    const heartbeatIndexes = Object.keys(snapshot.tables["public.heartbeat_runs"].indexes);
    expect(heartbeatIndexes).toContain(INDEX_NAME);
    expect(heartbeatIndexes).toContain("heartbeat_runs_company_ctx_issue_created_idx");
  });
});

d("db-care coalesce index declaration (embedded postgres)", () => {
  it("carries the four-column definition on a fresh chain", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-coalesce-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const rows = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'heartbeat_runs' AND indexname = ${INDEX_NAME}
    `;
    expect(rows.length).toBe(1);
    const indexdef = String(rows[0].indexdef);
    expect(indexdef).toContain(INDEX_NAME);
    expect(indexdef).toContain("company_id");
    expect(indexdef).toContain("coalesce");
    expect(indexdef).toContain("native_issue_id");
    expect(indexdef).toContain("issueId");
    expect(indexdef).toContain("created_at DESC");
    expect(indexdef).toContain("id DESC");
  }, 240_000);

  it("applies the migration twice on one database without creating a second index", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-coalesce-idem-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBe(1);

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }

    const rows = await sql.unsafe(`
      SELECT count(*) AS occurrences
      FROM pg_indexes
      WHERE tablename = 'heartbeat_runs' AND indexname = '${INDEX_NAME}'
    `);
    expect(Number(rows[0].occurrences)).toBe(1);
  }, 240_000);
});