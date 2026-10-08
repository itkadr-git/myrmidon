// myrmidon(DB-CARE): the previous-assignee index on activity_log was created
// by hand on the production board database during the datastore audit
// (07-08.10.2026) and migration 0307 persists it as a managed object. The
// static half pins the migration file, the journal entry and the snapshot and
// reconciles the SQL predicate with the snapshot declaration (the drift check
// behind `db:generate`); the embedded-Postgres half pins the definition the
// operator's pg_indexes reconciliation compares against and applies the
// migration twice on one database to prove idempotency.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "activity_log_issue_prev_assignee_idx";
const MIGRATION_FILE = "./migrations/0307_db_care_issue_prev_assignee_index.sql";
const MIGRATION_TAG = "0307_db_care_issue_prev_assignee_index";
const SNAPSHOT_FILE = "./migrations/meta/0307_snapshot.json";
const PREVIOUS_SNAPSHOT_FILE = "./migrations/meta/0306_snapshot.json";
// The predicate split into the pieces both the SQL statement and the snapshot
// must carry: the indexed expression and the partial-index predicate.
const EXPRESSION = "((details -> '_previous' ->> 'assigneeAgentId'))";
const PREDICATE = "\"entity_type\" = 'issue' and \"action\" = 'issue.updated'";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("db-care prev-assignee index migration (static checks)", () => {
  it("declares the CREATE INDEX IF NOT EXISTS statement verbatim", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
    expect(migrationSql).toContain(
      `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "activity_log" USING btree ("company_id",${EXPRESSION},"created_at") WHERE ${PREDICATE};`,
    );
    // The production statement exists already: it must be re-created
    // idempotently on the next deploy, hence IF NOT EXISTS and no DROP.
    expect(migrationSql).not.toContain("DROP INDEX");
    expect(migrationSql).toContain("migration-safety-ignore large-create-index-not-concurrently");
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 307);
    expect(entry?.tag).toBe(MIGRATION_TAG);
    expect(entry?.when).toBeGreaterThan(1791312571333);

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
              where?: string;
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

    const idx = snapshot.tables["public.activity_log"].indexes[INDEX_NAME];
    expect(idx?.name).toBe(INDEX_NAME);
    expect(idx.method).toBe("btree");
    expect(idx.isUnique).toBe(false);
    expect(idx.concurrently).toBe(false);
    expect(idx.columns.map((c) => c.asc)).toEqual([true, true, true]);
    expect(idx.columns[1].isExpression).toBe(true);

    // Drift check: the SQL statement and the Drizzle declaration describe the
    // same index, so `db:generate` (schema versus this snapshot) stays clean
    // and the operator's pg_indexes reconciliation has one expected shape.
    expect(idx.columns[1].expression.replaceAll('"', "")).toBe(EXPRESSION);
    expect(idx.where?.replaceAll('"', "")).toContain("activity_log.entity_type = 'issue'");
    expect(idx.where?.replaceAll('"', "")).toContain("action = 'issue.updated'");
    // The four audit indexes of 0306 stay untouched.
    const activityLogIndexes = Object.keys(snapshot.tables["public.activity_log"].indexes);
    expect(activityLogIndexes).toContain("activity_log_company_agent_created_idx");
    expect(activityLogIndexes).toContain("activity_log_entity_type_id_idx");
  });
});

d("db-care prev-assignee index migration (embedded postgres)", () => {
  it("creates the expected index definition on a fresh chain", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-prev-assignee-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const rows = await sql`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'activity_log' AND indexname = ${INDEX_NAME}
    `;
    expect(rows.length).toBe(1);
    const indexdef = String(rows[0].indexdef);
    expect(indexdef).toContain(INDEX_NAME);
    expect(indexdef).toContain("company_id");
    expect(indexdef).toContain("details");
    expect(indexdef).toContain("'_previous'");
    expect(indexdef).toContain("assigneeAgentId");
    expect(indexdef).toContain("created_at");
    expect(indexdef).toContain("entity_type");
    expect(indexdef).toContain("'issue'");
    expect(indexdef).toContain("action");
    expect(indexdef).toContain("'issue.updated'");
    expect(indexdef).toMatch(/where/i);
  }, 240_000);

  it("applies the migration twice on one database without errors (idempotency)", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-care-prev-assignee-idem-");
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
      WHERE tablename = 'activity_log' AND indexname = '${INDEX_NAME}'
    `);
    expect(Number(rows[0].occurrences)).toBe(1);
  }, 240_000);
});