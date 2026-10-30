import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0422_clear_stale_replay_holds.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("migration 0422 clear stale replay holds", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("deduplicates historical holds, clears >24h stale holds, and journals durable audit records", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-0422-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Apply baseline migrations
    await applyPendingMigrations(database.connectionString);

    const companyId = randomUUID();
    const issueId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Migration Test Co', 'MTC')`;
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueId}, ${companyId}, 'replay hold test issue', 'todo', 'high')`;

    // Insert 2 historical duplicate actions on the same issue with replay='blocked'
    const action1Id = randomUUID();
    const action2Id = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "status", "action_type", "evidence", "created_at", "updated_at")
      VALUES
        (${action1Id}, ${companyId}, ${issueId}, 'resolved', 'escalate', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
        (${action2Id}, ${companyId}, ${issueId}, 'resolved', 'escalate', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours')
    `;

    // Apply migration 0422
    const migrationSql = await readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
    await sql.unsafe(migrationSql);

    // action1Id (rank 1, newer) should remain blocked (since < 24h)
    const [row1] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${action1Id}`;
    expect((row1.evidence as any).automaticRecovery.replay).toBe("blocked");

    // action2Id (rank 2, older duplicate) should be cleared by dedupe
    const [row2] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${action2Id}`;
    expect((row2.evidence as any).automaticRecovery.replay).toBe("cleared");
    expect((row2.evidence as any).automaticRecovery.replayClearedBy).toBe("migration_0422_dedupe");
    expect((row2.evidence as any).automaticRecovery.previousEvidence).toBeDefined();

    // Verify durable activity_log entry
    const auditRows = await sql`SELECT * FROM "activity_log" WHERE "actor_id" = 'migration_0422' AND "action" = 'issue.execution_recovery_settled'`;
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const dedupeAudit = auditRows.find((r) => (r.details as any).actionId === action2Id);
    expect(dedupeAudit).toBeDefined();
    expect((dedupeAudit!.details as any).reason).toContain("migration_0422_dedupe");
  }, 30_000);
});