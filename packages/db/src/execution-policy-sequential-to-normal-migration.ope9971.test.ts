import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

const MIGRATION_FILE = "0425_execution_policy_sequential_to_normal.sql";

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("execution policy sequential to normal migration (static checks)", () => {
  it("reads migration SQL and verifies update targets mode=sequential issues", async () => {
    const migrationSql = await readFile(
      fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url)),
      "utf8",
    );
    expect(migrationSql).toContain('UPDATE "issues"');
    expect(migrationSql).toContain('jsonb_set("execution_policy", \'{mode}\', \'"normal"\')');
    expect(migrationSql).toContain('"execution_policy"->>\'mode\' = \'sequential\'');
  });
});

d("execution policy sequential to normal migration (functional)", () => {
  it("migrates mode=sequential to normal and preserves stages and monitor", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-ope9971-");
    cleanups.push(async () => {
      await database.cleanup();
    });

    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await sql.end();
    });

    const companyId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "description", "status")
      VALUES (${companyId}, 'Test Company', 'Description', 'active')
    `;

    const issueSequentialId = randomUUID();
    const issueNormalId = randomUUID();
    const issueNullId = randomUUID();

    const sequentialPolicy = {
      mode: "sequential",
      stages: [{ id: "stage-1", type: "review", participants: [] }],
      monitor: { nextCheckAt: "2026-11-01T00:00:00.000Z", notes: "check" },
    };
    const normalPolicy = {
      mode: "normal",
      stages: [{ id: "stage-2", type: "review", participants: [] }],
    };

    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "status", "priority",
        "execution_policy"
      ) VALUES (
        ${issueSequentialId}, ${companyId}, 'Sequential Issue', 'in_progress', 'medium',
        ${sql.json(sequentialPolicy)}
      ), (\
        ${issueNormalId}, ${companyId}, 'Normal Issue', 'in_progress', 'medium',
        ${sql.json(normalPolicy)}
      ), (\
        ${issueNullId}, ${companyId}, 'Null Policy Issue', 'in_progress', 'medium',
        NULL
      )
    `;

    // Apply the migration SQL
    const migrationSql = await readFile(
      fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url)),
      "utf8",
    );
    await sql.unsafe(migrationSql);

    // Verify sequential was migrated to normal
    const [migrated] = await sql<{ execution_policy: Record<string, unknown> }[]>`
      SELECT "execution_policy" FROM "issues" WHERE "id" = ${issueSequentialId}
    `;
    expect(migrated?.execution_policy?.mode).toBe("normal");
    expect(migrated?.execution_policy?.stages).toEqual(sequentialPolicy.stages);
    expect(migrated?.execution_policy?.monitor).toEqual(sequentialPolicy.monitor);

    // Verify normal was unchanged
    const [normal] = await sql<{ execution_policy: Record<string, unknown> }[]>`
      SELECT "execution_policy" FROM "issues" WHERE "id" = ${issueNormalId}
    `;
    expect(normal?.execution_policy?.mode).toBe("normal");
    expect(normal?.execution_policy?.stages).toEqual(normalPolicy.stages);

    // Verify null remained null
    const [nullIssue] = await sql<{ execution_policy: unknown }[]>`
      SELECT "execution_policy" FROM "issues" WHERE "id" = ${issueNullId}
    `;
    expect(nullIssue?.execution_policy).toBeNull();

    // Verify acceptance query
    const [acceptance] = await sql<{ count: string }[]>`
      SELECT count(*) as count FROM "issues" WHERE "execution_policy"->>'mode' NOT IN ('normal', 'auto')
    `;
    expect(Number(acceptance?.count)).toBe(0);
  }, 60_000);
});
