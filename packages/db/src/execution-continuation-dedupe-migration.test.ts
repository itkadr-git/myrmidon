// 0380: cleanup of the historical executionContinuation duplicates in
// heartbeat_runs.context_snapshot. The canonical copy is the top-level
// executionContinuation; the nested paperclipWake.executionContinuation is the
// duplicate the migration removes (and lifts first when no top-level copy exists).
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0380_remove_execution_continuation_duplication.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

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

const envelope = { version: 1, mode: "resume", note: "kept" };

d("execution continuation dedupe migration", () => {
  it("removes the nested duplicate, lifts a nested-only envelope, and is idempotent", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap165-dedupe-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => {
      await sql.end();
    });

    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Dedupe Co', 'DDP')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config", "runtime_config", "permissions")
      VALUES (${agentId}, ${companyId}, 'Coder', 'engineer', 'idle', 'codex_local', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    `;

    const insertRun = async (snapshot: Record<string, unknown> | null): Promise<string> => {
      const id = randomUUID();
      await sql`
        INSERT INTO "heartbeat_runs" ("id", "company_id", "agent_id", "status", "context_snapshot", "created_at", "updated_at")
        VALUES (${id}, ${companyId}, ${agentId}, 'succeeded', ${snapshot === null ? null : sql.json(snapshot as never)}, now(), now())
      `;
      return id;
    };

    // Class 1: top-level and nested copies.
    const both = await insertRun({
      issueId: "i-1",
      executionContinuation: envelope,
      paperclipWake: { reason: "r", executionContinuation: envelope },
    });
    // Class 3: only the nested copy (an external adapter under the old contract).
    const nestedOnly = await insertRun({
      issueId: "i-2",
      paperclipWake: { reason: "r", executionContinuation: envelope },
    });
    // Class 2: no top-level copy and a nested JSON null.
    const nestedNull = await insertRun({
      paperclipWake: { reason: "r", executionContinuation: null },
    });
    // Clean rows: nothing to do.
    const clean = await insertRun({ issueId: "i-3", executionContinuation: envelope, paperclipWake: { reason: "r" } });
    const noWake = await insertRun({ issueId: "i-4" });
    const nullSnapshot = await insertRun(null);
    // Not an object: the nested value is a string, the migration must not fail on it.
    const scalarWake = await insertRun({ issueId: "i-5", paperclipWake: "none" });
    // Many rows so the loop crosses the 200-row batch boundary.
    const bulk: string[] = [];
    for (let i = 0; i < 450; i += 1) {
      bulk.push(
        await insertRun({
          n: i,
          executionContinuation: { ...envelope, n: i },
          paperclipWake: { executionContinuation: { ...envelope, n: i } },
        }),
      );
    }

    const read = async (id: string) => {
      const rows = await sql`SELECT "context_snapshot" AS snap FROM "heartbeat_runs" WHERE "id" = ${id}`;
      return rows[0]?.snap as Record<string, unknown> | null;
    };
    const before = {
      clean: await read(clean),
      noWake: await read(noWake),
      scalarWake: await read(scalarWake),
    };

    const statements = await migrationStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) await sql.unsafe(statement);

    // Class 1: the nested copy is gone, the top-level copy and the rest are intact.
    expect(await read(both)).toEqual({
      issueId: "i-1",
      executionContinuation: envelope,
      paperclipWake: { reason: "r" },
    });
    // Class 3: lifted to the top level, then removed from the nested object.
    expect(await read(nestedOnly)).toEqual({
      issueId: "i-2",
      executionContinuation: envelope,
      paperclipWake: { reason: "r" },
    });
    // Class 2: the nested null is dropped, no top-level key is invented.
    expect(await read(nestedNull)).toEqual({ paperclipWake: { reason: "r" } });
    // Untouched rows are identical.
    expect(await read(clean)).toEqual(before.clean);
    expect(await read(noWake)).toEqual(before.noWake);
    expect(await read(nullSnapshot)).toBeNull();
    expect(await read(scalarWake)).toEqual(before.scalarWake);
    // Every bulk row, across the batch boundaries.
    const leftover = await sql`
      SELECT count(*)::int AS n FROM "heartbeat_runs"
      WHERE "context_snapshot" -> 'paperclipWake' ? 'executionContinuation'
    `;
    expect(leftover[0]?.n).toBe(0);
    const topLevelKept = await sql`
      SELECT count(*)::int AS n FROM "heartbeat_runs"
      WHERE "context_snapshot" ? 'n' AND "context_snapshot" -> 'executionContinuation' ->> 'n' = "context_snapshot" ->> 'n'
    `;
    expect(topLevelKept[0]?.n).toBe(bulk.length);

    // A second run changes nothing: not a row, not an updated_at, not a byte.
    const snapshotBefore = await sql`SELECT "id", "context_snapshot"::text AS snap, "updated_at" FROM "heartbeat_runs" ORDER BY "id"`;
    for (const statement of statements) await sql.unsafe(statement);
    const snapshotAfter = await sql`SELECT "id", "context_snapshot"::text AS snap, "updated_at" FROM "heartbeat_runs" ORDER BY "id"`;
    expect(snapshotAfter).toEqual(snapshotBefore);
  }, 240_000);
});
