import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0422_legacy_blocked_import.sql";
const cleanups: Array<() => Promise<void>> = [];

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describe("legacy_blocked_import migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("is repeatable and enforces import-key uniqueness per company", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-blocked-import-");
    cleanups.push(database.cleanup);
    const db = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => db.end());

    await db`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await db`DROP TABLE IF EXISTS "legacy_blocked_import" CASCADE`;
    await applyPendingMigrations(database.connectionString);
    await applyPendingMigrations(database.connectionString);

    const companyId = randomUUID();
    const issueId = randomUUID();
    await db`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Legacy Import Test', 'LIT')`;
    await db`INSERT INTO "issues" ("id", "company_id", "title") VALUES (${issueId}, ${companyId}, 'Legacy blocked source')`;
    await db`INSERT INTO "legacy_blocked_import" ("company_id", "import_key", "issue_id", "class") VALUES (${companyId}, 'legacy-1', ${issueId}, 'blocked')`;
    await expect(
      db`INSERT INTO "legacy_blocked_import" ("company_id", "import_key", "issue_id", "class") VALUES (${companyId}, 'legacy-1', ${issueId}, 'blocked')`,
    ).rejects.toMatchObject({ code: "23505", constraint_name: "legacy_blocked_import_company_import_key_uq" });
  }, 30_000);
});
