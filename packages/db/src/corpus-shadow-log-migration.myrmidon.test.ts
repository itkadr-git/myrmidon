// myrmidon(1.6.6-CORPUS-SHADOW A): the corpus_shadow_log table (part A of the corpus
// shadow comparison). Static checks pin the migration file, the journal entry
// and the snapshot against the frozen shadow-log column contract; the
// embedded-Postgres half applies the migration on the migrated database,
// proves it is idempotent, and round-trips one row with the module-error
// shape the runner writes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0409_corpus_shadow_log.sql";
const COLUMNS = [
  "id",
  "ts",
  "bot_id",
  "dataset",
  "query",
  "ragflow_chunk_ids",
  "ragflow_latency_ms",
  "module_chunk_ids",
  "module_latency_ms",
  "module_error",
];

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("corpus shadow log migration (static checks)", () => {
  it("pins the contract columns and the ts index", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBe(2);
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS "corpus_shadow_log"');
    for (const column of COLUMNS) expect(migrationSql).toContain(`"${column}"`);
    // The contract: uuid pk with a default, timestamptz, jsonb chunk lists,
    // int latencies, and a nullable module_error (the only failure surface).
    expect(migrationSql).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL');
    expect(migrationSql).toContain('"ts" timestamp with time zone DEFAULT now() NOT NULL');
    expect(migrationSql).toContain('"ragflow_chunk_ids" jsonb');
    expect(migrationSql).toContain('"module_chunk_ids" jsonb');
    expect(migrationSql).toContain('"module_error" text');
    expect(migrationSql).toContain('CREATE INDEX IF NOT EXISTS "corpus_shadow_log_ts_idx" ON "corpus_shadow_log" ("ts")');
  });

  it("registers the migration in the journal and chains the snapshot from the previous one", async () => {
    const journal = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const position = journal.entries.findIndex((e) => e.tag === "0409_corpus_shadow_log");
    expect(position).toBeGreaterThan(0);
    const entry = journal.entries[position];
    expect(entry?.idx).toBe(409);
    const previous = journal.entries[position - 1];
    expect(previous?.idx).toBe(408);
    expect(entry!.when).toBeGreaterThan(previous!.when);

    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0409_snapshot.json", import.meta.url)), "utf8"),
    ) as { id: string; prevId: string; tables: Record<string, unknown> };
    const prevSnapshot = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0408_snapshot.json", import.meta.url)), "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(prevSnapshot.id);
    expect(snapshot.id).not.toBe(prevSnapshot.id);
    expect(snapshot.tables["public.corpus_shadow_log"]).toBeDefined();
  });
});

d("corpus shadow log migration (embedded Postgres)", () => {
  it(
    "applies on the migrated database, is idempotent, and round-trips a shadow row",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-corpus-shadow-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1 });
      cleanups.push(async () => sql.end());
      const migration = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");

      // Apply twice: re-running the migration must not fail.
      await sql.unsafe(migration);
      await sql.unsafe(migration);

      // Column shape comes from the catalog, not from the file text.
      const columns = await sql<{ column_name: string; is_nullable: string; data_type: string }[]>`
        SELECT column_name, is_nullable, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'corpus_shadow_log'
        ORDER BY ordinal_position
      `;
      expect(columns.map((c) => c.column_name)).toEqual(COLUMNS);
      const moduleError = columns.find((c) => c.column_name === "module_error")!;
      expect(moduleError.is_nullable).toBe("YES");
      expect(columns.find((c) => c.column_name === "id")!.is_nullable).toBe("NO");

      // A row of the failed-module shape the runner inserts.
      const inserted = await sql<{ id: string; ts: string; module_error: string | null }[]>`
        INSERT INTO "corpus_shadow_log"
          ("bot_id", "dataset", "query", "ragflow_chunk_ids", "ragflow_latency_ms",
           "module_chunk_ids", "module_latency_ms", "module_error")
        VALUES
          ('bot-1', 'kb', 'q?', '["r1","r2"]'::jsonb, 40, NULL, 7, 'corpus down')
        RETURNING "id", "ts", "module_error"
      `;
      expect(inserted.length).toBe(1);
      expect(inserted[0]!.id).toMatch(/-/);
      expect(inserted[0]!.module_error).toBe("corpus down");
      // ts and id defaults exist even when the runner omits them.
      const defaults = await sql<{ count: string }[]>`
        INSERT INTO "corpus_shadow_log" ("query", "ragflow_chunk_ids", "ragflow_latency_ms", "module_chunk_ids", "module_latency_ms")
        VALUES ('q2', '[]'::jsonb, 10, '[]', 1)
        RETURNING 1 AS ok
      `;
      expect(defaults.length).toBe(1);

      const p95StyleRead = await sql<{ ragflow_latency_ms: number }[]>`
        SELECT "ragflow_latency_ms" FROM "corpus_shadow_log" ORDER BY "ts" DESC
      `;
      expect(p95StyleRead.map((r) => r.ragflow_latency_ms).sort()).toEqual([10, 40]);
    },
    120_000,
  );
});
