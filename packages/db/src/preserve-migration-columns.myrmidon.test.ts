import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("preserve migration columns", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("adds the approved columns without changing existing rows and preserves null/default semantics", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-preserve-columns-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());
    await applyPendingMigrations(database.connectionString);

    // Model a supported legacy source that has neither approved field yet.
    await sql`ALTER TABLE "agents" DROP COLUMN "appearance"`;
    await sql`ALTER TABLE "issues" DROP COLUMN "title_needs_generation"`;

    const companyId = randomUUID();
    const agentWithAppearance = randomUUID();
    const agentWithoutAppearance = randomUUID();
    const issueTrue = randomUUID();
    const issueFalse = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Migration test', 'MIG')`;
    await sql`INSERT INTO "agents" ("id", "company_id", "name", "adapter_config") VALUES
      (${agentWithAppearance}, ${companyId}, 'with appearance', '{}'::jsonb),
      (${agentWithoutAppearance}, ${companyId}, 'without appearance', '{}'::jsonb)`;
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES
      (${issueTrue}, ${companyId}, 'true case', 'backlog', 'medium'),
      (${issueFalse}, ${companyId}, 'false case', 'backlog', 'medium')`;

    const migration = await fs.promises.readFile(
      new URL("./migrations/0418_preserve_migration_columns.sql", import.meta.url),
      "utf8",
    );
    await sql.unsafe(migration);

    const agents = await sql`SELECT "id", "appearance" FROM "agents" WHERE "company_id" = ${companyId} ORDER BY "id"`;
    const issues = await sql`SELECT "id", "title_needs_generation" FROM "issues" WHERE "company_id" = ${companyId} ORDER BY "id"`;
    expect(agents.find((row) => row.id === agentWithoutAppearance)?.appearance).toBeNull();
    expect(issues.find((row) => row.id === issueTrue)?.title_needs_generation).toBe(false);
    expect(issues.find((row) => row.id === issueFalse)?.title_needs_generation).toBe(false);

    await sql`UPDATE "agents" SET "appearance" = ${sql.json({ nested: { value: 42 } })} WHERE "id" = ${agentWithAppearance}`;
    await sql`UPDATE "issues" SET "title_needs_generation" = true WHERE "id" = ${issueTrue}`;
    expect((await sql`SELECT "appearance" FROM "agents" WHERE "id" = ${agentWithAppearance}`)[0]?.appearance).toEqual({ nested: { value: 42 } });
    expect((await sql`SELECT "title_needs_generation" FROM "issues" WHERE "id" = ${issueTrue}`)[0]?.title_needs_generation).toBe(true);

    await sql.unsafe(migration);
    const finalCount = await sql`SELECT count(*)::int AS count FROM "agents" WHERE "company_id" = ${companyId}`;
    expect(finalCount).toEqual([{ count: 2 }]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
