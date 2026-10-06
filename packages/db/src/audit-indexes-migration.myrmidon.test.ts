// myrmidon(1.6.5-DB-AUDIT-INDEXES): the four audit indexes on heartbeat_runs
// and issues (db audit section 2, findings P3/P5/P6; the P1 coalesce index
// ships in a separate migration). Static checks pin the migration file,
// journal entry and snapshot; the embedded-Postgres half applies the migration
// twice on one database to prove idempotency.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0306_audit_indexes_heartbeat_issues.sql";
const INDEXES_ON_HEARTBEAT_RUNS = [
  "heartbeat_runs_company_agent_created_idx",
  "heartbeat_runs_ctx_issue_status_idx",
];
const INDEXES_ON_ISSUES = [
  "issues_company_execution_run_idx",
  "issues_company_checkout_run_idx",
];
const ALL_INDEXES = [...INDEXES_ON_HEARTBEAT_RUNS, ...INDEXES_ON_ISSUES];

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("audit indexes migration (static checks)", () => {
  it("declares all four CREATE INDEX IF NOT EXISTS statements verbatim", async () => {
    const migrationSql = await readFile(fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)), "utf8");
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBe(4);

    for (const name of ALL_INDEXES) {
      expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS "${name}"`);
    }
    // Expressions verbatim from the audit: the P1 blocker index (the coalesce
    // expression index PR #619 persists) is NOT part of this migration.
    expect(migrationSql).not.toContain("heartbeat_runs_company_issue_coalesce_created_idx");
    expect(migrationSql).toContain(
      `CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at")`,
    );
    expect(migrationSql).toContain(
      `CREATE INDEX IF NOT EXISTS "heartbeat_runs_ctx_issue_status_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" ->> 'issueId'),"status")`,
    );
    expect(migrationSql).toContain(
      `CREATE INDEX IF NOT EXISTS "issues_company_execution_run_idx" ON "issues" USING btree ("company_id","execution_run_id")`,
    );
    expect(migrationSql).toContain(
      `CREATE INDEX IF NOT EXISTS "issues_company_checkout_run_idx" ON "issues" USING btree ("company_id","checkout_run_id")`,
    );
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 306);
    expect(entry?.tag).toBe("0306_audit_indexes_heartbeat_issues");
    expect(entry?.when).toBeGreaterThan(1791206402990);

    const snapshot = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/0306_snapshot.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      id: string;
      prevId: string;
      tables: Record<string, { indexes: Record<string, { name: string; columns: Array<{ expression: string; isExpression?: boolean; asc: boolean; nulls: string }>; isUnique: boolean; concurrently: boolean; method: string }> }>;
    };
    const prev = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/0305_snapshot.json", import.meta.url)),
        "utf8",
      ),
    ) as { id: string };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);

    const hb = snapshot.tables["public.heartbeat_runs"].indexes;
    const iss = snapshot.tables["public.issues"].indexes;
    for (const name of INDEXES_ON_HEARTBEAT_RUNS) expect(hb[name]?.name).toBe(name);
    for (const name of INDEXES_ON_ISSUES) expect(iss[name]?.name).toBe(name);
    expect(hb.heartbeat_runs_ctx_issue_status_idx.columns[1].expression).toBe(
      "(\"context_snapshot\" ->> 'issueId')",
    );
    expect(hb.heartbeat_runs_ctx_issue_status_idx.columns[1].isExpression).toBe(true);
    expect(hb.heartbeat_runs_company_agent_created_idx.columns.map((c) => c.asc)).toEqual([true, true, true]);
    for (const idx of Object.values(hb).concat(Object.values(iss))) {
      if (!ALL_INDEXES.includes(idx.name)) continue;
      expect(idx.isUnique).toBe(false);
      expect(idx.concurrently).toBe(false);
      expect(idx.method).toBe("btree");
    }
    // The 0209 sibling index is different (created_at DESC, no status) — it
    // must stay untouched in the snapshot.
    expect(hb.heartbeat_runs_company_ctx_issue_created_idx).toBeTruthy();
    expect(hb.heartbeat_runs_company_ctx_issue_created_idx.columns[2].asc).toBe(false);
  });
});

d("audit indexes migration (embedded postgres)", () => {
  it("applies the full chain and serves the audited queries", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-audit-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const rows = await sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('heartbeat_runs','issues')`;
    const names = rows.map((r) => r.indexname as string);
    for (const name of ALL_INDEXES) expect(names).toContain(name);

    await sql.unsafe("SET enable_seqscan = off");
    // P3 attention-feed shape: company + agent IN + created_at window.
    const feedPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND agent_id IN ('00000000-0000-0000-0000-000000000002') AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 50",
    );
    expect(feedPlan.map((r) => Object.values(r)[0]).join("\n")).toContain(
      "heartbeat_runs_company_agent_created_idx",
    );
    // P5 milestone projection shape: company + context issueId + status filter.
    const milestonePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'issueId' = 'x' AND status IN ('failed','timed_out') LIMIT 10",
    );
    expect(milestonePlan.map((r) => Object.values(r)[0]).join("\n")).toContain(
      "heartbeat_runs_ctx_issue_status_idx",
    );
    // P6 claim lockup shape: company + (execution_run_id or checkout_run_id).
    // On the tiny embedded table the planner may legitimately pick any
    // company-prefixed index, so the pin here is "no Seq Scan" (the production
    // failure mode the audit flagged); index existence is asserted above.
    const claimPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM issues WHERE company_id = '00000000-0000-0000-0000-000000000001' AND execution_run_id = '00000000-0000-0000-0000-000000000003' FOR UPDATE",
    );
    expect(claimPlan.map((r) => Object.values(r)[0]).join("\n")).not.toContain(
      "Seq Scan",
    );
    const checkoutPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM issues WHERE company_id = '00000000-0000-0000-0000-000000000001' AND checkout_run_id = '00000000-0000-0000-0000-000000000003' FOR UPDATE",
    );
    expect(checkoutPlan.map((r) => Object.values(r)[0]).join("\n")).not.toContain(
      "Seq Scan",
    );
  }, 240_000);

  it("applies the migration twice on one database without errors (idempotency)", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-audit-idx-idem-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const migrationSql = await readFile(
      fileURLToPath(new URL(MIGRATION_FILE, import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBe(4);

    for (let pass = 0; pass < 2; pass += 1) {
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }

    const quoted = ALL_INDEXES.map((name) => `'${name}'`).join(",");
    const rows = await sql.unsafe(`
      SELECT indexname, count(*) AS occurrences
      FROM pg_indexes
      WHERE tablename IN ('heartbeat_runs','issues')
        AND indexname IN (${quoted})
      GROUP BY indexname
    `);
    expect(rows.length).toBe(4);
    for (const row of rows) expect(Number(row.occurrences)).toBe(1);
  }, 240_000);
});
