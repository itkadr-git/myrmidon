// myrmidon(1.6.5-F-15): the attention screen's exhausted-runs query re-read the
// whole heartbeat_run_events slice of the company: server/src/services/
// attention-exhausted-runs.ts filters company_id + event_type = 'lifecycle' +
// message like 'Bounded retry exhausted%' before it joins the run rows, and the
// two non-unique indexes on the table (company_run, company_created) do not
// carry event_type, so the leg ran as a sequential scan (F-15 trace: the
// attention feed sat at p50 2.3 s / p95 4.7 s with every poll missing cache).
//
// Static checks pin the migration file, the journal entry and the snapshot
// entry. The embedded-Postgres half applies the migration statement twice on a
// seeded database to prove idempotency, drops it to prove the query falls back
// to a sequential scan (the assertions have teeth), then re-applies it and
// pins the exhausted-runs leg on a bitmap or index scan of the new partial
// index. See docs/myrmidon/DIVERGENCE.md.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "./migrations/0381_attention_exhausted_lifecycle_idx.sql";
const INDEX_NAME = "heartbeat_run_events_company_lifecycle_run_idx";
const CREATE_STATEMENT =
  `CREATE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "heartbeat_run_events" USING btree ("company_id","event_type","run_id") WHERE "event_type" = 'lifecycle'`;

/** The exhausted-runs leg of listAttentionExhaustedRuns, verbatim shape. */
const EXHAUSTED_LEG = `
  SELECT DISTINCT ON (run_id) run_id, id, message
  FROM heartbeat_run_events
  WHERE company_id = $1
    AND event_type = 'lifecycle'
    AND message like 'Bounded retry exhausted%'
  ORDER BY run_id ASC, id DESC
`;

/** Lifecycle events of the probed company: the slice the index must serve. */
const COMPANY_LIFECYCLE_SLICE = 2_000;
/** Adapter events per lifecycle run of the probed company (the noise). */
const COMPANY_NOISE_PER_RUN = 33;
/** Other event rows on the heap the sequential scan must read anyway. */
const MIN_TABLE_EVENTS = 80_000;
/** Other companies' events: prove the scan is table-wide, not company-wide. */
const OTHER_COMPANIES = 19;

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

describe("attention exhausted-runs index migration (static checks)", () => {
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
    // Drizzle migrations run transactionally: CONCURRENTLY is not an option
    // here. heartbeat_run_events is a large-bucket table, so the statement
    // carries the 0307-style migration-safety-ignore for the warning; the
    // index itself stays a plain CREATE INDEX IF NOT EXISTS (same shape as
    // 0306/0308).
    expect(migrationSql).toContain(
      "-- paperclip:migration-safety-ignore large-create-index-not-concurrently:",
    );
    expect(migrationSql).not.toMatch(/CONCURRENTLY\s+"?heartbeat_run_events/);
  });

  it("registers the migration in the journal and the snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url)),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.idx === 381);
    expect(entry?.tag).toBe("0381_attention_exhausted_lifecycle_idx");
    const prevEntry = journal.entries.find((e) => e.idx === 380);
    expect(entry!.when).toBeGreaterThan(prevEntry!.when);

    const snapshot = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/0381_snapshot.json", import.meta.url)),
        "utf8",
      ),
    ) as {
      id: string;
      prevId: string;
      tables: Record<string, { indexes: Record<string, unknown> }>;
    };
    const prev = JSON.parse(
      await readFile(
        fileURLToPath(new URL("./migrations/meta/0380_snapshot.json", import.meta.url)),
        "utf8",
      ),
    ) as { id: string };
    expect(snapshot.prevId).toBe(prev.id);
    expect(snapshot.id).not.toBe(prev.id);

    const events = snapshot.tables["public.heartbeat_run_events"].indexes as Record<
      string,
      {
        name: string;
        columns: Array<{ expression: string; isExpression: boolean; asc: boolean }>;
        isUnique: boolean;
        concurrently: boolean;
        method: string;
        where?: string;
      }
    >;
    const added = events[INDEX_NAME];
    expect(added?.name).toBe(INDEX_NAME);
    expect(added.columns.map((c) => c.expression)).toEqual(["company_id", "event_type", "run_id"]);
    expect(added.columns.every((c) => !c.isExpression && c.asc)).toBe(true);
    expect(added.isUnique).toBe(false);
    expect(added.concurrently).toBe(false);
    expect(added.method).toBe("btree");
    expect(added.where).toBe(`"heartbeat_run_events"."event_type" = 'lifecycle'`);
    // The two existing non-unique indexes stay untouched.
    expect(events.heartbeat_run_events_company_run_idx).toBeTruthy();
    expect(events.heartbeat_run_events_company_created_idx).toBeTruthy();
  });

  it("keeps the schema declaration in sync with the migration", async () => {
    const schema = await readFile(
      fileURLToPath(new URL("./schema/heartbeat_run_events.ts", import.meta.url)),
      "utf8",
    );
    expect(schema).toContain(`index("${INDEX_NAME}")`);
    expect(schema).toContain(".on(table.companyId, table.eventType, table.runId)");
    expect(schema).toContain("sql`${table.eventType} = 'lifecycle'`");
  });
});

d("attention exhausted-runs index migration (embedded postgres)", () => {
  it("serves the exhausted-runs leg off the index and falls back without it", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-f15-exhausted-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // 1) Seed the production shape: one company whose lifecycle slice is small
    // next to its adapter traffic, and nineteen other companies.
    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      VALUES (${companyId}, 'F15 seed target', 'F15', false, 'responsible-user')
    `;
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      SELECT gen_random_uuid(), 'F15 filler ' || i, 'F' || lpad(i::text, 3, '0'), false, 'responsible-user'
      FROM generate_series(1, ${OTHER_COMPANIES}) i
    `;
    await sql`
      INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      VALUES (${agentId}, ${companyId}, 'F15 agent', 'engineer', 'active', 'codex_local', '{}'::jsonb,
              '{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1}}'::jsonb, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO agents (id, company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      SELECT gen_random_uuid(), c.id, 'F15 filler agent', 'engineer', 'active', 'codex_local', '{}'::jsonb,
             '{"heartbeat":{"wakeOnDemand":true,"maxConcurrentRuns":1}}'::jsonb, '{}'::jsonb
      FROM companies c WHERE c.id <> ${companyId}
    `;
    // The probed company owns COMPANY_LIFECYCLE_SLICE runs — one lifecycle
    // event each — and the other companies share the rest of the heap.
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode)
      SELECT gen_random_uuid(), ${companyId}, ${agentId}, 'failed', 'legacy'
      FROM generate_series(1, ${COMPANY_LIFECYCLE_SLICE}) g
    `;
    await sql`
      INSERT INTO heartbeat_runs (id, company_id, agent_id, status, runtime_mode)
      SELECT gen_random_uuid(), a.company_id, a.id, 'failed', 'legacy'
      FROM agents a CROSS JOIN generate_series(1, 200) g
      WHERE a.company_id <> ${companyId}
    `;
    // The probed company's adapter traffic (the noise the partial index skips).
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      SELECT hr.company_id, hr.id, hr.agent_id, g, 'adapter.invoke', 'tool call ' || g
      FROM heartbeat_runs hr
      CROSS JOIN generate_series(1, ${COMPANY_NOISE_PER_RUN}) g
      WHERE hr.company_id = ${companyId}
    `;
    // The probed company's lifecycle slice: the migration's partial index
    // serves this block; a small part of it matches the exhausted prefix.
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      SELECT hr.company_id, hr.id, hr.agent_id, ${COMPANY_NOISE_PER_RUN + 1}, 'lifecycle',
             CASE WHEN hashtext(hr.id::text) % 20 = 0
                  THEN 'Bounded retry exhausted for run ' || hr.id
                  ELSE 'lifecycle marker ' || hr.id END
      FROM heartbeat_runs hr
      WHERE hr.company_id = ${companyId}
    `;
    // The rest of the heap: other companies' events, so the unhedged plan is a
    // table-wide sequential scan and not just a company-wide one.
    await sql`
      INSERT INTO heartbeat_run_events (company_id, run_id, agent_id, seq, event_type, message)
      SELECT hr.company_id, hr.id, hr.agent_id, g, 'adapter.invoke', 'tool call ' || g
      FROM heartbeat_runs hr
      CROSS JOIN generate_series(1, 4) g
      WHERE hr.company_id <> ${companyId}
    `;
    await sql`ANALYZE heartbeat_run_events`;

    const tableRows = await sql`
      SELECT count(*)::int AS n FROM heartbeat_run_events
    `;
    expect(tableRows[0]!.n).toBeGreaterThanOrEqual(MIN_TABLE_EVENTS);
    const otherRows = await sql`
      SELECT count(*)::int AS n FROM heartbeat_run_events WHERE company_id <> ${companyId}
    `;
    expect(otherRows[0]!.n).toBeGreaterThan(COMPANY_LIFECYCLE_SLICE);
    const lifecycleRows = await sql`
      SELECT count(*)::int AS n FROM heartbeat_run_events
      WHERE company_id = ${companyId} AND event_type = 'lifecycle'
        AND message LIKE 'Bounded retry exhausted%'
    `;
    expect(lifecycleRows[0]!.n).toBeGreaterThan(0);

    // 2) The migration is in the applied chain: the index exists on the table
    // and is visible in the system catalog view (pg_indexes is the Postgres
    // information_schema surface for indexes).
    const idx = await sql`
      SELECT tablename FROM pg_indexes WHERE indexname = ${INDEX_NAME}
    `;
    expect(idx.map((row) => row.tablename as string)).toEqual(["heartbeat_run_events"]);

    // 3) With the index the leg is served by it: the plan names the partial
    // index and reads no sequential scan of the events table. The partial
    // index already carries the event_type predicate, so the per-row filter
    // only ever removes the non-matching lifecycle messages of the probed
    // company — bounded by the seeded lifecycle slice, a fraction of the
    // table-wide work the sequential scan does (assertion 4).
    const withIndex = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${EXHAUSTED_LEG}`, [
      companyId,
    ]);
    const withIndexText = planText(withIndex);
    expect(withIndexText).toMatch(/heartbeat_run_events_company_lifecycle_run_idx/);
    expect(withIndexText).not.toMatch(/Seq Scan on heartbeat_run_events/);

    // 4) Drop the index: the same statement falls back to the sequential scan —
    // the production failure mode, and the proof that assertion 3 has teeth.
    // The other non-unique indexes on the table do not carry event_type, so no
    // index path for this leg survives the drop.
    await sql`DROP INDEX IF EXISTS ${sql(INDEX_NAME)}`;
    await sql`ANALYZE heartbeat_run_events`;
    const withoutIndex = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${EXHAUSTED_LEG}`, [
      companyId,
    ]);
    const withoutIndexText = planText(withoutIndex);
    expect(withoutIndexText).toMatch(/Seq Scan on heartbeat_run_events/);
    expect(rowsRemovedByFilter(withoutIndexText)).toBeGreaterThan(1_000);

    // 5) Re-apply the migration statement twice on one database: IF NOT EXISTS
    // makes the second pass a no-op and the index is not duplicated.
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
    const reapplied = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${EXHAUSTED_LEG}`, [
      companyId,
    ]);
    expect(planText(reapplied)).toMatch(/heartbeat_run_events_company_lifecycle_run_idx/);
    expect(planText(reapplied)).not.toMatch(/Seq Scan on heartbeat_run_events/);
  }, 240_000);
});
