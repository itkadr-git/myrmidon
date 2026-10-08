// OPE-5007 П2: the 0309 run-context-columns migration — catalog-only shape,
// idempotency, and the thin-column read shape.
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0309_run_context_columns.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("run context columns migration", () => {
  it("creates the nine columns with ADD COLUMN only and re-applies cleanly", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap165-cols-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    // The full chain already ran (embedded helper applies it), so the
    // columns exist. Verify them on top of the fresh schema.
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name LIKE 'context\_%'
        AND column_name <> 'context_snapshot'
    `;
    expect(cols.map((r) => r.column_name).sort()).toEqual(
      [
        "context_comment_id",
        "context_issue_id",
        "context_run_summary",
        "context_task_id",
        "context_task_key",
        "context_wake_comment_id",
        "context_wake_reason",
        "context_wake_source",
        "context_wake_trigger_detail",
      ].sort(),
    );

    // The migration is catalog-only: no DML, no PL/pgSQL loop. Backfill is a
    // separate batched job (server run-context-columns-backfill), so the
    // migration transaction never rewrites rows of the hot table.
    const statements = await migrationStatements();
    expect(statements).toHaveLength(9);
    for (const statement of statements) {
      const code = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n");
      expect(code).toMatch(/^ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_\w+" text;?$/);
    }
    const rawSql = statements.join("\n");
    expect(rawSql).not.toMatch(/\bUPDATE\b\s+"?heartbeat_runs/i);
    expect(rawSql).not.toMatch(/\bDO\b\s+\$/i);

    // Idempotent re-apply on top of the finished chain.
    for (const statement of statements) {
      await sql.unsafe(statement);
    }

    // Rows written before the backfill ran keep resolving through coalesce.
    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Cols Co', 'COLS')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config", "runtime_config", "permissions")
      VALUES (${agentId}, ${companyId}, 'Coder', 'engineer', 'idle', 'codex_local', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;
    const oldRunId = randomUUID();
    const issueId = randomUUID();
    await sql`
      INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "context_snapshot", "created_at", "updated_at")
      VALUES (${oldRunId}, ${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId } as never)}, now(), now())
    `;
    const readBack = await sql`
      SELECT coalesce(context_issue_id, context_snapshot ->> 'issueId') AS issue_id
      FROM "heartbeat_runs" WHERE "id" = ${oldRunId}
    `;
    expect(readBack[0]?.issue_id).toBe(issueId);
  }, 240_000);

  it("the new SELECT list reads thin columns without detoasting toast-heavy snapshots", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap165-toast-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Toast Co', 'TST')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config", "runtime_config", "permissions")
      VALUES (${agentId}, ${companyId}, 'Toast', 'engineer', 'idle', 'codex_local', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;

    const ROWS = 150;
    // ~60 KB of high-entropy text per row: pglz cannot shrink it below the
    // TOAST threshold, so every snapshot lands in the toast table — exactly
    // the production shape the thin-column read must avoid touching.
    const entropyPayload = (seed: number) => {
      let s = seed;
      const parts: string[] = [];
      while (parts.join("").length < 60_000) {
        s = (s * 1103515245 + 12345) % 2147483648;
        parts.push((s >>> 0).toString(32));
      }
      return parts.join("");
    };
    for (let index = 0; index < ROWS; index += 1) {
      await sql`
        INSERT INTO "heartbeat_runs"
          ("id", "company_id", "agent_id", "status", "context_snapshot",
           "context_issue_id", "created_at", "updated_at")
        VALUES (
          ${randomUUID()}, ${companyId}, ${agentId}, 'succeeded',
          ${sql.json({ issueId: `issue-${index}`, prompt: entropyPayload(index + 1) } as never)},
          ${`issue-${index}`}, now(), now()
        )
      `;
    }
    await sql`VACUUM ANALYZE "heartbeat_runs"`;

    // Old projection: every row's snapshot must be detoasted to extract the key.
    const oldPlan = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT context_snapshot ->> 'issueId' FROM heartbeat_runs WHERE company_id = '${companyId}'`,
    );
    const oldBuffers = planSharedBlocks(oldPlan);
    // New projection: thin column hit; the coalesce never touches the toast
    // table for rows that carry the column.
    const newPlan = await sql.unsafe(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) SELECT coalesce(context_issue_id, context_snapshot ->> 'issueId') FROM heartbeat_runs WHERE company_id = '${companyId}'`,
    );
    const newBuffers = planSharedBlocks(newPlan);
    // 150 rows x 60 KB snapshot = ~4.5 MB of toast; the column path must read
    // a small fraction of that.
    expect(newBuffers).toBeLessThan(oldBuffers / 10);
  }, 240_000);
});

function planSharedBlocks(planRows: Array<Record<string, unknown>>): number {
  // postgres.js returns EXPLAIN rows as text values ("QUERY PLAN"): either a
  // TEXT block per line, or one JSON document string for FORMAT JSON.
  // Node buffer counters are inclusive of descendants, so the root Plan's
  // numbers are the totals. Key spellings vary across PG majors, so match
  // "Shared Hit Blocks"/"Shared_Read_Blocks" style keys generically.
  const queue: unknown[] = [...planRows];
  while (queue.length > 0) {
    const node = queue.pop();
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        try {
          queue.push(JSON.parse(trimmed));
          continue;
        } catch {
          // fall through to TEXT scanning below
        }
      }
      const match = /Buffers:\s*shared\s+hit=(\d+)(?:\s+read=(\d+))?(?:\s+dirtied=(\d+))?(?:\s+written=(\d+))?/.exec(node);
      if (match) {
        return match.slice(1).reduce((sum, part) => sum + Number(part ?? 0), 0);
      }
      continue;
    }
    if (!node || typeof node !== "object") continue;
    const obj = node as Record<string, unknown>;
    if (obj.Plan && typeof obj.Plan === "object") {
      const plan = obj.Plan as Record<string, unknown>;
      let total = 0;
      for (const [key, value] of Object.entries(plan)) {
        const n = key.replace(/ /g, "_").toLowerCase();
        if (/^(shared|temp)/.test(n) && /(hit|read|dirtied|written)/.test(n) && /(blk|block)/.test(n) && typeof value === "number") total += value;
      }
      return total;
    }
    queue.push(...Object.values(obj));
  }
  return 0;
}
