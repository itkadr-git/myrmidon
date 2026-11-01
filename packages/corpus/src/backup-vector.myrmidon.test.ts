import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import zlib from "node:zlib";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  runDatabaseBackup,
  runDatabaseRestore,
} from "@myrmidon/db";
import {
  installPgvectorIntoEmbeddedCluster,
  type PgvectorInstall,
} from "./test-pgvector.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const support = await getEmbeddedPostgresTestSupport();
let pgvectorInstall: PgvectorInstall = {
  ok: false,
  reason: "not attempted",
  cleanup: async () => {},
};
if (support.supported) {
  pgvectorInstall = await installPgvectorIntoEmbeddedCluster();
}
const runnable = support.supported && pgvectorInstall.ok;
const d = runnable ? describe : describe.skip;

if (!runnable) {
  console.warn(
    `backup-vector test skipped: ${
      support.supported ? pgvectorInstall.reason : (support.reason ?? "embedded Postgres unsupported")
    }`,
  );
}

afterAll(async () => {
  await pgvectorInstall.cleanup();
});

d("backup-lib: vector(1024) and hnsw index", () => {
  it("backs up and restores tables with vector(1024) and hnsw index without losing dimensions", async () => {
    const sourceDb = await startEmbeddedPostgresTestDatabase("backup-vec-src-");
    const targetDb = await startEmbeddedPostgresTestDatabase("backup-vec-dst-");
    const scratchDir =
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ??
      process.env.PAPERCLIP_SCRATCH_DIR ??
      os.tmpdir();
    const tmpDir = await mkdtemp(path.join(scratchDir, "backup-vec-test-"));

    const sourceSql = postgres(sourceDb.connectionString);
    const targetSql = postgres(targetDb.connectionString);

    try {
      await sourceSql.unsafe(`
        CREATE EXTENSION IF NOT EXISTS vector;
        DROP TABLE IF EXISTS "corpus_chunks" CASCADE;
        CREATE TABLE "corpus_chunks" (
          "id" uuid PRIMARY KEY,
          "content" text NOT NULL,
          "embedding" vector(1024)
        );
        CREATE INDEX "corpus_chunks_embedding_hnsw_idx"
          ON "corpus_chunks" USING hnsw ("embedding" vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        INSERT INTO "corpus_chunks" ("id", "content", "embedding")
        VALUES (
          '11111111-1111-4111-8111-111111111111',
          'test vector content',
          ('[' || array_to_string(array_fill(0.123::float4, ARRAY[1024]), ',') || ']')::vector
        );
      `);

      const backupResult = await runDatabaseBackup({
        connectionString: sourceDb.connectionString,
        backupDir: tmpDir,
        retention: {
          dailyDays: 1,
          weeklyWeeks: 0,
          monthlyMonths: 0,
          keepLastOnly: true,
        },
        backupEngine: "javascript",
      });

      const backupGz = await readFile(backupResult.backupFile);
      const backupSql = zlib.gunzipSync(backupGz).toString("utf8");
      expect(backupSql).toMatch(/"vector"\(1024\)/);
      expect(backupSql).not.toMatch(/"embedding"\s+"public"\."vector"\s*[,)]/);

      await targetSql.unsafe(`
        CREATE EXTENSION IF NOT EXISTS vector;
        DROP TABLE IF EXISTS "corpus_chunks" CASCADE;
      `);

      await runDatabaseRestore({
        connectionString: targetDb.connectionString,
        backupFile: backupResult.backupFile,
      });

      const cols = await targetSql<{ column_name: string; formatted_type: string }[]>`
        SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS formatted_type
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND t.relname = 'corpus_chunks' AND a.attname = 'embedding'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.formatted_type).toBe("vector(1024)");

      const rows = await targetSql<{ id: string; content: string }[]>`
        SELECT id, content FROM "corpus_chunks"
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe("test vector content");

      const idx = await targetSql<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'corpus_chunks' AND indexname = 'corpus_chunks_embedding_hnsw_idx'
      `;
      expect(idx).toHaveLength(1);
      expect(idx[0]?.indexdef).toContain("hnsw");
    } finally {
      await sourceSql.end();
      await targetSql.end();
      await sourceDb.cleanup();
      await targetDb.cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
