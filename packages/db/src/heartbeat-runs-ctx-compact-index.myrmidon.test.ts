// packages/db/src/heartbeat-runs-ctx-compact-index.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-9967): retention compaction on heartbeat_runs for
// terminal runs older than cutoff was rescanning tens of thousands of already
// compacted rows (98h DB time, statement_timeout every 85s).
//
// Static checks pin the migration file, the journal entry, the snapshot
// entry, and the schema index definition.
// The embedded-Postgres test seeds a table where 60% of rows are already compacted,
// verifies EXPLAIN (ANALYZE, BUFFERS) selects heartbeat_runs_ctx_compact_pending_idx,
// drops the index to prove fallback to sequential scan (the assertions have teeth),
// re-applies the migration statement twice to verify idempotence, and verifies the
// query returns to the partial index.

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0436_lush_greymalkin.sql";
const INDEX_NAME = "heartbeat_runs_ctx_compact_pending_idx";
const CREATE_STATEMENT =
  `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "heartbeat_runs" USING btree ("company_id","created_at") WHERE jsonb_exists("heartbeat_runs"."context_snapshot", 'executionContinuation') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipWake') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipWakeComment') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipTaskMarkdown') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipTaskMarkdownCompact') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipSessionHandoffMarkdown') or jsonb_exists("heartbeat_runs"."context_snapshot", 'paperclipContinuationSummary') or jsonb_exists("heartbeat_runs"."context_snapshot", 'externalChatContinuation')`;

/** The candidate batch query verbatim shape from datastore-care/retention/compact.ts. */
const CANDIDATE_BATCH_QUERY = `
  SELECT id, octet_length(context_snapshot::text) AS original_bytes
  FROM heartbeat_runs
  WHERE company_id = $1
    AND status IN ('succeeded', 'failed', 'timed_out', 'cancelled')
    AND created_at < $2::timestamptz
    AND (
      jsonb_exists(context_snapshot, 'executionContinuation')
      OR jsonb_exists(context_snapshot, 'paperclipWake')
      OR jsonb_exists(context_snapshot, 'paperclipWakeComment')
      OR jsonb_exists(context_snapshot, 'paperclipTaskMarkdown')
      OR jsonb_exists(context_snapshot, 'paperclipTaskMarkdownCompact')
      OR jsonb_exists(context_snapshot, 'paperclipSessionHandoffMarkdown')
      OR jsonb_exists(context_snapshot, 'paperclipContinuationSummary')
      OR jsonb_exists(context_snapshot, 'externalChatContinuation')
    )
  ORDER BY created_at ASC, id ASC
  LIMIT 500
`;

function planText(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => String(Object.values(row)[0])).join("\n");
}

function rowsRemovedByFilter(text: string): number {
  const matches = [...text.matchAll(/Rows Removed by Filter:\s*(\d+)/g)];
  return matches.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
}

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("heartbeat_runs context compact index migration (static checks)", () => {
  it("declares the partial index statement verbatim in the migration file", async () => {
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
    expect(migrationSql).toContain(
      "-- paperclip:migration-safety-ignore large-create-index-not-concurrently:",
    );
    expect(migrationSql).not.toMatch(/CONCURRENTLY\s+"?heartbeat_runs/);
  });

  it("registers the migration in the journal and the snapshot with matching index name", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 436);
    expect(entry?.tag).toBe("0436_lush_greymalkin");

    const snapshot = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/0436_snapshot.json", import.meta.url)),
        "utf8",
      ),
    ) as { tables: Record<string, { indexes: Record<string, { name: string }> }> };
    const runsIndexes = snapshot.tables["public.heartbeat_runs"]?.indexes ?? {};
    expect(runsIndexes[INDEX_NAME]?.name).toBe(INDEX_NAME);
  });
});

d("heartbeat_runs context compact partial index query plan", () => {
  it("uses the partial index on a table where 60% of rows are already compacted", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-ope9967-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(() => sql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'company-plan-test', 'PLN')
    `;
    await sql`
      INSERT INTO agents (id, company_id, name, role)
      VALUES (${agentId}, ${companyId}, 'agent-plan-test', 'worker')
    `;

    // 10,000 rows: 6,000 (60%) already compacted, 4,000 uncompacted
    await sql`
      INSERT INTO heartbeat_runs (
        id, company_id, agent_id, invocation_source, status,
        context_snapshot, created_at, updated_at
      )
      SELECT
        gen_random_uuid(),
        ${companyId}::uuid,
        ${agentId}::uuid,
        'assignment',
        'succeeded',
        CASE
          WHEN s <= 6000 THEN '{"taskKey": "OPE-1", "_compactedAt": "2026-10-20T00:00:00.000Z"}'::jsonb
          ELSE '{"taskKey": "OPE-1", "paperclipWake": "wake-data", "executionContinuation": "long-message-history"}'::jsonb
        END,
        now() - interval '20 days' + (s || ' seconds')::interval,
        now() - interval '20 days' + (s || ' seconds')::interval
      FROM generate_series(1, 10000) AS s
    `;
    await sql`ANALYZE heartbeat_runs`;

    // 1) The migration is applied: index exists
    const idx = await sql`
      SELECT tablename FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(idx.map((r) => r.tablename as string)).toEqual(["heartbeat_runs"]);

    // 2) With index: plan uses heartbeat_runs_ctx_compact_pending_idx
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const withIndex = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${CANDIDATE_BATCH_QUERY}`,
      [companyId, cutoff],
    );
    const withIndexText = planText(withIndex);
    expect(withIndexText).toMatch(new RegExp(INDEX_NAME));
    expect(rowsRemovedByFilter(withIndexText)).toBe(0);

    // 3) Drop index: query falls back to scanning full company created_at index or heap,
    // having to unpack context_snapshot for all 6,000 already-compacted rows (production defect)
    await sql`DROP INDEX IF EXISTS ${sql(INDEX_NAME)}`;
    await sql`ANALYZE heartbeat_runs`;
    const withoutIndex = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${CANDIDATE_BATCH_QUERY}`,
      [companyId, cutoff],
    );
    const withoutIndexText = planText(withoutIndex);
    expect(withoutIndexText).not.toMatch(new RegExp(INDEX_NAME));
    expect(rowsRemovedByFilter(withoutIndexText)).toBeGreaterThanOrEqual(6000);

    // 4) Re-apply migration statement twice: idempotent
    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const st of statements) {
        await sql.unsafe(st);
      }
    }
    const count = await sql`
      SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(count[0]!.n).toBe(1);

    // 5) Plan uses index again and removes 0 rows by filter
    await sql`ANALYZE heartbeat_runs`;
    const reapplied = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${CANDIDATE_BATCH_QUERY}`,
      [companyId, cutoff],
    );
    const reappliedText = planText(reapplied);
    expect(reappliedText).toMatch(new RegExp(INDEX_NAME));
    expect(rowsRemovedByFilter(reappliedText)).toBe(0);
  }, 120_000);
});
