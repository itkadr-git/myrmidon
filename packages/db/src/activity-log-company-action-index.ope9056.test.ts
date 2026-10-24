// myrmidon(1.6.6 DEFECT): the rc.15 board outage of 24.10.2026 — the feature
// health pass reads max(created_at) from activity_log filtered by company,
// action and (for the chat-holds leg) details->>'continuation'
// (server/src/myrmidon/features/ports.ts, activity.latest). No index carried
// "action", so on 1.15M rows the query ran 3-10 s, saturated myrmidon-pg
// (267% CPU) and pushed /api/health to 10-20 s. Migration 0415 adds
// (company_id, action, created_at DESC).
//
// Static checks pin the migration file, the journal entry and the snapshot
// entry, and reconcile the schema declaration. The embedded-Postgres half
// seeds a production-shaped table (a small action slice next to a large
// other-actions heap), pins the parameterized ports.ts statement verbatim on
// a bitmap/index scan of the new index, drops it to prove the fallback is
// the sequential scan (the assertions have teeth), re-applies the migration
// twice for idempotency and pins the plan back on the index.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0415_activity_log_company_action_created_idx.sql";
const MIGRATION_TAG = "0415_activity_log_company_action_created_idx";
const INDEX_NAME = "activity_log_company_action_created_idx";
const CREATE_STATEMENT =
  `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "activity_log" USING btree ("company_id","action","created_at" DESC)`;

/** The chat-holds leg of createDbFeaturePorts.activity.latest, verbatim shape
 * (drizzle's inArray with one element renders "company_id" = $1, and the
 * details key/value ride as parameters exactly as pg_stat_activity showed:
 * `details ->> $4 = $5`). */
const LATEST_LEG = `
  SELECT max("created_at") FROM "activity_log"
  WHERE "company_id" = $1 AND "action" = $2
    AND "created_at" >= $3 AND "details" ->> $4 = $5
`;

/** The swarm-claim leg: no details filter. */
const LATEST_LEG_NO_DETAIL = `
  SELECT max("created_at") FROM "activity_log"
  WHERE "company_id" = $1 AND "action" = $2 AND "created_at" >= $3
`;

/** Rows of the probed action in the probed company: the slice the index serves. */
const COMPANY_ACTION_ROWS = 40;
/** Noise rows of other actions in the probed company: what the index skips.
 * The probed company owns most of the heap (like 0381), so the unhedged plan
 * below is genuinely a sequential scan and not a bitmap over the pre-existing
 * (company_id, created_at) index. */
const COMPANY_NOISE_ROWS = 40_000;
/** Other companies' rows on the heap: the scan must be table-wide. */
const OTHER_COMPANIES = 19;
const OTHER_COMPANY_NOISE_ROWS = 1_000;
const OTHER_COMPANY_ACTION_ROWS = 50;

function planText(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => String(Object.values(row)[0])).join("\n");
}

/** Rows the plan's filter rejected: how much per-row work the leg did. */
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

describe("activity_log company/action/created index migration (static checks)", () => {
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
    // the 0307-style migration-safety-ignore for the warning; the index
    // itself stays a plain CREATE INDEX IF NOT EXISTS (same shape as
    // 0307/0308/0381).
    expect(migrationSql).toContain(
      "-- paperclip:migration-safety-ignore large-create-index-not-concurrently:",
    );
    expect(migrationSql).not.toMatch(/CONCURRENTLY\s+"?activity_log/);
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 415);
    expect(entry?.tag).toBe(MIGRATION_TAG);
    const prevEntry = journal.entries.find((e) => e.idx === 414);
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    const snapshot = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0415_snapshot.json", import.meta.url)), "utf8"),
    ) as {
      id: string;
      prevId: string;
      tables: Record<string, { indexes: Record<string, unknown> }>;
    };
    const prev = JSON.parse(
      await readFile(fileURLToPath(new URL("./migrations/meta/0414_snapshot.json", import.meta.url)), "utf8"),
    ) as { id: string };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);

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
    expect(added.columns.map((c) => c.expression)).toEqual(["company_id", "action", "created_at"]);
    expect(added.columns.map((c) => c.asc)).toEqual([true, true, false]);
    expect(added.columns.every((c) => !c.isExpression)).toBe(true);
    expect(added.isUnique).toBe(false);
    expect(added.concurrently).toBe(false);
    expect(added.method).toBe("btree");
    // The index is not partial: it serves every action, both legs.
    expect(added.where).toBeUndefined();
    // The pre-existing activity_log indexes stay untouched.
    expect(table.indexes.activity_log_company_created_idx).toBeTruthy();
    expect(table.indexes.activity_log_issue_last_activity_idx).toBeTruthy();
  });

  it("keeps the schema declaration in sync with the migration", async () => {
    const schema = await readFile(
      fileURLToPath(new URL("./schema/activity_log.ts", import.meta.url)),
      "utf8",
    );
    expect(schema).toContain(`index("${INDEX_NAME}")`);
    expect(schema).toContain(".on(\n      table.companyId,\n      table.action,\n      table.createdAt.desc(),\n    )");
  });
});

d("activity_log company/action/created index migration (embedded postgres)", () => {
  it("serves the feature-health lookup off the index and falls back without it", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-166-act-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // 1) Seed the production shape: one company whose
    // issue.execution_recovery_settled slice is small next to its other
    // activity traffic, and other companies sharing the rest of the heap.
    const companyId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      VALUES (${companyId}, '1.6.6 seed target', 'DEF', false, 'responsible-user')
    `;
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      SELECT gen_random_uuid(), '1.6.6 filler ' || i, 'F' || lpad(i::text, 3, '0'), false, 'responsible-user'
      FROM generate_series(1, ${OTHER_COMPANIES}) i
    `;
    // The probed company's probed action: the slice the index must resolve.
    // The rows sit six days back — old and rare next to the company's fresh
    // traffic, the production shape (a settle event is occasional, the other
    // audit actions are constant), so a backward walk over the pre-existing
    // (company_id, created_at) index must dig through the whole fresh heap
    // before it finds one, while the new index seeks the slice directly.
    // Every row carries the details->>'continuation' the leg filters on and
    // stays inside the 7-day lookback.
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), ${companyId}, 'system', 'execution-recovery',
             'issue.execution_recovery_settled', 'issue', gen_random_uuid()::text,
             jsonb_build_object('continuation', 'chat_owner_message', 'recoveryActionId', gen_random_uuid()::text),
             now() - interval '6 days' + (g || ' minutes')::interval
      FROM generate_series(1, ${COMPANY_ACTION_ROWS}) g
    `;
    // The probed company's other activity traffic: newer than the settle
    // events, so the newest heap rows all fail the action filter.
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), ${companyId}, 'system', 'seed', 'issue.updated', 'issue', gen_random_uuid()::text, '{}'::jsonb,
             now() - (random() * interval '5 days')
      FROM generate_series(1, ${COMPANY_NOISE_ROWS}) g
    `;
    // The same action in other companies' rows: prove the slice is per
    // company, not per action table-wide.
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), c.id, 'system', 'seed', 'issue.execution_recovery_settled', 'issue', gen_random_uuid()::text,
             jsonb_build_object('continuation', 'chat_owner_message'),
             now() - (random() * interval '6 days')
      FROM companies c CROSS JOIN generate_series(1, ${OTHER_COMPANY_ACTION_ROWS}) g
      WHERE c.id <> ${companyId}
    `;
    // The rest of the heap: other companies' noise, so the unhedged plan is a
    // table-wide sequential scan and not just a company-wide one.
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), c.id, 'system', 'seed', 'issue.updated', 'issue', gen_random_uuid()::text, '{}'::jsonb,
             now() - (random() * interval '6 days')
      FROM companies c CROSS JOIN generate_series(1, ${OTHER_COMPANY_NOISE_ROWS}) g
      WHERE c.id <> ${companyId}
    `;
    await sql`ANALYZE activity_log`;

    const tableRows = await sql`SELECT count(*)::int AS n FROM activity_log`;
    expect(tableRows[0]!.n).toBeGreaterThanOrEqual(
      OTHER_COMPANIES * OTHER_COMPANY_ACTION_ROWS + COMPANY_NOISE_ROWS,
    );
    const actionRows = await sql`
      SELECT count(*)::int AS n FROM activity_log WHERE company_id = ${companyId} AND action = 'issue.execution_recovery_settled'
    `;
    expect(actionRows[0]!.n).toBe(COMPANY_ACTION_ROWS);

    // 2) The migration is in the applied chain: the index exists on the table.
    const idx = await sql`SELECT tablename FROM pg_indexes WHERE indexname = ${INDEX_NAME}`;
    expect(idx.map((row) => row.tablename as string)).toEqual(["activity_log"]);

    // 3) With the index, both legs of activity.latest are served by it: the
    // plan names the new index and reads no sequential scan of activity_log.
    // The details->>'continuation' residual runs on the index slice only —
    // the per-row filter work collapses to the probed action's rows.
    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const withIndex = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${LATEST_LEG}`, [
      companyId,
      "issue.execution_recovery_settled",
      from,
      "continuation",
      "chat_owner_message",
    ]);
    const withIndexText = planText(withIndex);
    expect(withIndexText).toMatch(new RegExp(INDEX_NAME));
    expect(withIndexText).not.toMatch(/Seq Scan on activity_log/);
    // The details residual is evaluated only on the index slice: the per-row
    // filter work collapses to the probed action's rows (every seeded row of
    // the slice matches the residual, so nothing is removed), never the
    // thousands of rows the unhedged scan reads.
    expect(rowsRemovedByFilter(withIndexText)).toBeLessThan(COMPANY_ACTION_ROWS);

    const withIndexNoDetail = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${LATEST_LEG_NO_DETAIL}`, [
      companyId,
      "issue.execution_recovery_settled",
      from,
    ]);
    const noDetailText = planText(withIndexNoDetail);
    expect(noDetailText).toMatch(new RegExp(INDEX_NAME));
    expect(noDetailText).not.toMatch(/Seq Scan on activity_log/);

    // 4) Drop the index: the same statement falls back to the sequential
    // scan — the production failure mode, and the proof that assertion 3 has
    // teeth. No other index carries action, so no index path survives.
    await sql`DROP INDEX IF EXISTS ${sql(INDEX_NAME)}`;
    await sql`ANALYZE activity_log`;
    const withoutIndex = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${LATEST_LEG}`, [
      companyId,
      "issue.execution_recovery_settled",
      from,
      "continuation",
      "chat_owner_message",
    ]);
    const withoutIndexText = planText(withoutIndex);
    expect(withoutIndexText).toMatch(/Seq Scan on activity_log/);
    expect(rowsRemovedByFilter(withoutIndexText)).toBeGreaterThan(1_000);

    // 5) Re-apply the migration statement twice on one database: IF NOT
    // EXISTS makes the second pass a no-op and the index is not duplicated.
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
    const occurrences = await sql`
      SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(occurrences[0]!.n).toBe(1);

    // 6) After the re-apply the leg is on the index again.
    const reapplied = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${LATEST_LEG}`, [
      companyId,
      "issue.execution_recovery_settled",
      from,
      "continuation",
      "chat_owner_message",
    ]);
    expect(planText(reapplied)).toMatch(new RegExp(INDEX_NAME));
    expect(planText(reapplied)).not.toMatch(/Seq Scan on activity_log/);
  }, 240_000);
});
