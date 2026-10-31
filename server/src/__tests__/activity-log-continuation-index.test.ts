import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { createDb, type Db } from "@myrmidon/db";
import { createDbFeaturePorts } from "../myrmidon/features/ports.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@myrmidon/db/test-embedded-postgres";

const MIGRATION_FILE = "../../../packages/db/src/migrations/0428_activity_log_company_action_continuation_idx.sql";
const INDEX_NAME = "activity_log_company_action_continuation_idx";
/** Rows of the probed action whose continuation matches the lift filter: the
 * slice the expression index must resolve. */
const LIFT_ROWS = 40;
/** Rows of the same action in the same company with a different continuation:
 * the rc.16 failure mode — the action slice is big, and only the details key
 * separates the lift lines from the rest. With only 0415 these are all read
 * from the heap and rejected by the residual. */
const SETTLED_OTHER_CONTINUATION_ROWS = 20_000;
/** Other actions in the probed company: what any (company, action) index
 * skips. */
const COMPANY_NOISE_ROWS = 5_000;

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

d("activity_log company/action/continuation expression index migration (embedded postgres)", () => {
  it("serves the parameterized chat-holds leg off the index, custom and generic plans", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("db-166-cont-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = createDb(dbh.connectionString).$client;
    cleanups.push(async () => {
      await sql.end();
    });

    // 1) Seed the rc.16 shape: one company whose
    // issue.execution_recovery_settled slice contains few lift lines (the
    // probed continuation) buried in many settled replays of other
    // continuations — the heap rows the 0415 plan read and rejected — plus
    // unrelated newer traffic.
    const companyId = randomUUID();
    await sql`
      INSERT INTO companies (id, name, issue_prefix, require_board_approval_for_new_agents, default_responsible_user_id)
      VALUES (${companyId}, '1.6.6 continuation seed', 'DEF', false, 'responsible-user')
    `;
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), ${companyId}, 'system', 'execution-recovery',
             'issue.execution_recovery_settled', 'issue', gen_random_uuid()::text,
             jsonb_build_object('continuation', 'chat_owner_message', 'recoveryActionId', gen_random_uuid()::text),
             now() - interval '6 days' + (g || ' minutes')::interval
      FROM generate_series(1, ${LIFT_ROWS}) g
    `;
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), ${companyId}, 'system', 'execution-recovery',
             'issue.execution_recovery_settled', 'issue', gen_random_uuid()::text,
             jsonb_build_object('continuation', 'auto_resume'),
             now() - (random() * interval '6 days')
      FROM generate_series(1, ${SETTLED_OTHER_CONTINUATION_ROWS}) g
    `;
    await sql`
      INSERT INTO activity_log (id, company_id, actor_type, actor_id, action, entity_type, entity_id, details, created_at)
      SELECT gen_random_uuid(), ${companyId}, 'system', 'seed', 'issue.updated', 'issue', gen_random_uuid()::text, '{}'::jsonb,
             now() - (random() * interval '5 days')
      FROM generate_series(1, ${COMPANY_NOISE_ROWS}) g
    `;
    await sql`ANALYZE activity_log`;

    const observedQueries: Array<{ query: string; params: unknown[] }> = [];
    const observedDb = drizzle(sql, {
      logger: {
        logQuery(query, params) {
          observedQueries.push({ query, params });
        },
      },
    });
    const ports = createDbFeaturePorts(observedDb as unknown as Db);
    const detail = { key: "continuation", value: "chat_owner_message" };
    const since = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const [expected] = await sql`
      SELECT max(created_at) AS at FROM activity_log
      WHERE company_id = ${companyId} AND action = 'issue.execution_recovery_settled'
        AND details ->> 'continuation' = 'chat_owner_message'
    `;
    expect(await ports.activity.count(["issue.execution_recovery_settled"], since, detail)).toBe(LIFT_ROWS);
    expect(await ports.activity.latest(["issue.execution_recovery_settled"], detail)).toEqual(new Date(expected!.at));
    const actualQueries = observedQueries.filter(({ query }) => /from "activity_log"/i.test(query));
    expect(actualQueries).toHaveLength(2);
    for (const { query, params } of actualQueries) {
      expect(query).toContain("->> 'continuation'");
      expect(query).not.toContain("chat_owner_message");
      expect(params).toContain("chat_owner_message");
      expect(params).not.toContain("continuation");
      expect(query).toMatch(/->> 'continuation' = \$\d+/);
    }
    const unsafeDetail = { key: "continuation' OR true --", value: "chat_owner_message" };
    await expect(ports.activity.count(["issue.execution_recovery_settled"], since, unsafeDetail))
      .rejects.toThrow("activity details filter key is not a plain word");
    await expect(ports.activity.latest(["issue.execution_recovery_settled"], unsafeDetail))
      .rejects.toThrow("activity details filter key is not a plain word");
    const latestQuery = actualQueries[1]!;

    const tableRows = await sql`SELECT count(*)::int AS n FROM activity_log`;
    expect(tableRows[0]!.n).toBeGreaterThanOrEqual(SETTLED_OTHER_CONTINUATION_ROWS + COMPANY_NOISE_ROWS);
    const liftRows = await sql`
      SELECT count(*)::int AS n FROM activity_log
      WHERE company_id = ${companyId} AND action = 'issue.execution_recovery_settled'
        AND details ->> 'continuation' = 'chat_owner_message'
    `;
    expect(liftRows[0]!.n).toBe(LIFT_ROWS);

    // 2) The migration is in the applied chain: the index exists.
    const idx = await sql`SELECT tablename FROM pg_indexes WHERE indexname = ${INDEX_NAME}`;
    expect(idx.map((row) => row.tablename as string)).toEqual(["activity_log"]);

    // 3) Custom (EXPLAIN-time) plan: the parameterized leg reads the
    // expression index; the continuation residual moves off the heap.
    const withIndex = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${latestQuery.query}`,
      latestQuery.params as never[],
    );
    const withIndexText = planText(withIndex);
    expect(withIndexText).toMatch(new RegExp(INDEX_NAME));
    expect(withIndexText).not.toMatch(/Seq Scan on activity_log/);
    expect(rowsRemovedByFilter(withIndexText)).toBeLessThan(LIFT_ROWS);

    // 4) Force PostgreSQL to use a generic prepared plan, then confirm the
    // server reports that plan type and the expression index is selected.
    // The key is a literal; company/action/since/value are the bound params.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.unsafe(
        `PREPARE leg_ope9056 AS ${latestQuery.query}`,
      );
      try {
        for (let i = 0; i < 6; i += 1) {
          const leg = `EXECUTE leg_ope9056('${companyId}', 'issue.execution_recovery_settled', '${String(latestQuery.params[2])}', 'chat_owner_message')`;
          const rows = await tx.unsafe(leg);
          expect(rows.length).toBe(1);
        }
        const explainLeg = `EXPLAIN (ANALYZE, FORMAT TEXT) EXECUTE leg_ope9056('${companyId}', 'issue.execution_recovery_settled', '${String(latestQuery.params[2])}', 'chat_owner_message')`;
        const generic = await tx.unsafe(explainLeg);
        const genericText = planText(generic);
        expect(genericText).toMatch(new RegExp(INDEX_NAME));
        expect(genericText).not.toMatch(/Seq Scan on activity_log/);
        const planCounts = await tx`SELECT generic_plans FROM pg_prepared_statements WHERE name = 'leg_ope9056'`;
        expect(Number(planCounts[0]?.generic_plans)).toBeGreaterThan(0);
      } finally {
        await tx`DEALLOCATE leg_ope9056`;
      }
    });

    // 5) Drop the index: the same statement falls back to the heap residual
    // — the rc.16 plan (Rows Removed by Filter ~ the settled heap). The
    // assertions above have teeth.
    await sql`DROP INDEX IF EXISTS ${sql(INDEX_NAME)}`;
    await sql`ANALYZE activity_log`;
    const withoutIndex = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${latestQuery.query}`,
      latestQuery.params as never[],
    );
    const withoutIndexText = planText(withoutIndex);
    expect(withoutIndexText).not.toMatch(new RegExp(INDEX_NAME));
    expect(rowsRemovedByFilter(withoutIndexText)).toBeGreaterThanOrEqual(SETTLED_OTHER_CONTINUATION_ROWS);

    // 6) Re-apply the migration statement twice: IF NOT EXISTS keeps it a
    // no-op and the index is not duplicated.
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

    // 7) After the re-apply the leg is on the index again.
    const reapplied = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${latestQuery.query}`,
      latestQuery.params as never[],
    );
    expect(planText(reapplied)).toMatch(new RegExp(INDEX_NAME));
    expect(planText(reapplied)).not.toMatch(/Seq Scan on activity_log/);
  }, 240_000);
});
