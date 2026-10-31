import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "./migrations/0428_activity_log_company_action_continuation_idx.sql";
const MIGRATION_TAG = "0428_activity_log_company_action_continuation_idx";
const INDEX_NAME = "activity_log_company_action_continuation_idx";
const CREATE_STATEMENT =
  `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "activity_log" USING btree ("company_id","action",((details ->> 'continuation')),"created_at" DESC)`;

describe("activity_log company/action/continuation expression index migration (static checks)", () => {
  it("declares the CREATE INDEX IF NOT EXISTS statement verbatim in the migration file", async () => {
    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBe(1);
    expect(statements[0]!.endsWith(`${CREATE_STATEMENT};`)).toBe(true);
    // Drizzle migrations run transactionally: CONCURRENTLY is not an option
    // here. activity_log is a large-bucket table, so the statement carries
    // the 0307-style migration-safety-ignore for the warning.
    expect(migrationSql).toContain(
      "-- paperclip:migration-safety-ignore large-create-index-not-concurrently:",
    );
    expect(migrationSql).not.toMatch(/CONCURRENTLY\s+"?activity_log/);
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === MIGRATION_TAG);
    expect(entry?.tag).toBe(MIGRATION_TAG);
    const prevEntry = journal.entries.find((e) => e.idx === 425);
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0428_snapshot.json", import.meta.url)), "utf8"),
    ) as {
      id: string;
      prevId: string;
      tables: Record<string, { indexes: Record<string, unknown> }>;
    };
    const previous = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0425_snapshot.json", import.meta.url)), "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(previous.id);
    expect(snapshot.id).not.toBe(previous.id);

    const table = snapshot.tables["public.activity_log"];
    const added = table.indexes[INDEX_NAME] as {
      name: string;
      columns: Array<{ expression: string; isExpression: boolean; asc: boolean }>;
      isUnique: boolean;
      concurrently: boolean;
      method: string;
      where?: string;
    };
    expect(added?.name).toBe(INDEX_NAME);
    expect(added.columns.map((c) => c.expression)).toEqual([
      "company_id",
      "action",
      "((\"details\" ->> 'continuation'))",
      "created_at",
    ]);
    expect(added.columns.map((c) => c.isExpression)).toEqual([false, false, true, false]);
    expect(added.columns.map((c) => c.asc)).toEqual([true, true, true, false]);
    expect(added.isUnique).toBe(false);
    expect(added.concurrently).toBe(false);
    expect(added.method).toBe("btree");
    // The index is not partial: the production statement binds key and value
    // as parameters, so no partial predicate could be implied from it.
    expect(added.where).toBeUndefined();
    // The 0415 index stays (it serves the no-detail swarm-claim leg).
    expect(table.indexes.activity_log_company_action_created_idx).toBeTruthy();
  });

  it("keeps the schema declaration in sync with the migration", async () => {
    const schema = await readFile(
      fileURLToPath(new URL("./schema/activity_log.ts", import.meta.url)),
      "utf8",
    );
    expect(schema).toContain(`index("${INDEX_NAME}")`);
    expect(schema).toContain("sql`((${table.details} ->> 'continuation'))`");
  });

});
