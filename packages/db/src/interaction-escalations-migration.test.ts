import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0421_fixed_grim_reaper.sql";
const UNIQUE_INDEX = "interaction_escalations_interaction_level_uq";
const migrationSql = await readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;



describeEmbedded("interaction escalation migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("is repeatable, enforces interaction/level uniqueness, and cascades on interaction deletion", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-interaction-escalations-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Escalation Test Co', 'ETC')`;
    await sql`INSERT INTO "agents" ("id", "company_id", "name", "status", "adapter_type", "adapter_config", "runtime_config", "permissions") VALUES (${agentId}, ${companyId}, 'agent-one', 'idle', 'paperclip_runner', '{}', '{}', '{}')`;
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueId}, ${companyId}, 'escalation test issue', 'in_progress', 'high')`;
    await sql`INSERT INTO "issue_thread_interactions" ("id", "company_id", "issue_id", "kind", "payload") VALUES (${interactionId}, ${companyId}, ${issueId}, 'ask_user_questions', '{}')`;

    await applyPendingMigrations(database.connectionString);
    await applyPendingMigrations(database.connectionString);
    await sql`INSERT INTO "interaction_escalations" ("company_id", "interaction_id", "level", "from_recipient", "to_recipient", "reason") VALUES (${companyId}, ${interactionId}, 1, '{}', '{}', 'timeout')`;
    await expect(
      sql`INSERT INTO "interaction_escalations" ("company_id", "interaction_id", "level", "from_recipient", "to_recipient", "reason") VALUES (${companyId}, ${interactionId}, 1, '{}', '{}', 'duplicate')`,
    ).rejects.toMatchObject({ code: "23505", constraint_name: UNIQUE_INDEX });

    await sql`DELETE FROM "issue_thread_interactions" WHERE "id" = ${interactionId}`;
    const rows = await sql`SELECT "id" FROM "interaction_escalations" WHERE "interaction_id" = ${interactionId}`;
    expect(rows).toHaveLength(0);
  }, 30_000);
});