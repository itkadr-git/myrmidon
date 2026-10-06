import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

// myrmidon(OPE-4131-B / OPE-4106): the conversation ownership blocker
// (server/src/services/conversation-continuation.ts) filters heartbeat_runs by
// coalesce(native_issue_id::text, context_snapshot->>'issueId'); without a
// matching expression index every blocker check detoasted the company
// partition. The operator index existed only on production; migration 0302
// persists it.
d("heartbeat_runs company/issue coalesce expression index migration", () => {
  it("applies, serves the blocker predicate, and is idempotent", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("ope4778-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'heartbeat_runs'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_issue_coalesce_created_idx");

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND coalesce(native_issue_id::text, context_snapshot ->> 'issueId') = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_runs_company_issue_coalesce_created_idx");

    // Idempotency: re-running the migration statements against an already
    // migrated database (or one where the operator created the index
    // manually, as on production) must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(
        new URL(
          "./migrations/0302_heartbeat_runs_company_issue_coalesce_created_index.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    const idxAfter = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'heartbeat_runs' AND indexname = 'heartbeat_runs_company_issue_coalesce_created_idx'`;
    expect(idxAfter.length).toBe(1);
  }, 240_000);
});
