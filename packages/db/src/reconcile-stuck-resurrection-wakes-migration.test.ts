import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0463_reconcile_stuck_resurrection_wakes.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("migration 0463 reconcile stuck resurrection wakes", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("requeues scoped stranded pending wakes and closes unscoped ones; leaves other reasons untouched", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-0463-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Apply baseline migrations
    await applyPendingMigrations(database.connectionString);

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Migration Test Co 0463', 'M46')`;

    const agentId = randomUUID();
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name")
      VALUES (${agentId}, ${companyId}, 'adm-dev-eng-migration-test')
    `;

    const issueAId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueAId}, ${companyId}, 'scoped issue A', 'todo', 'high')`;
    const issueBId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueBId}, ${companyId}, 'scoped issue B', 'todo', 'high')`;

    const wakeScopedA = randomUUID();
    const wakeScopedB = randomUUID();
    const wakeUnscoped = randomUUID();
    const wakeOtherReason = randomUUID();
    const wakeOtherStatus = randomUUID();
    await sql`
      INSERT INTO "agent_wakeup_requests" ("id", "company_id", "agent_id", "source", "trigger_detail", "reason", "payload", "status", "requested_at", "created_at", "updated_at")
      VALUES
        -- 1. scoped stranded wake -> requeued as deferred_issue_execution
        (${wakeScopedA}, ${companyId}, ${agentId}, 'automation', 'system', 'resurrection_execution_reconciliation_required', ${sql.json({ issueId: issueAId })}::jsonb, 'pending', NOW() - INTERVAL '20 hours', NOW() - INTERVAL '20 hours', NOW() - INTERVAL '20 hours'),
        -- 2. scoped stranded wake with empty-string issueId -> closed as failed (NULLIF misses the double-encoded string)
        (${wakeScopedB}, ${companyId}, ${agentId}, 'automation', 'system', 'resurrection_execution_reconciliation_required', ${sql.json({ issueId: "" })}::jsonb, 'pending', NOW() - INTERVAL '18 hours', NOW() - INTERVAL '18 hours', NOW() - INTERVAL '18 hours'),
        -- 3. unscoped stranded wake (no issueId) -> closed as failed
        (${wakeUnscoped}, ${companyId}, ${agentId}, 'automation', 'system', 'resurrection_execution_reconciliation_required', '{}'::jsonb, 'pending', NOW() - INTERVAL '16 hours', NOW() - INTERVAL '16 hours', NOW() - INTERVAL '16 hours'),
        -- 4. same reason but different status -> untouched
        (${wakeOtherReason}, ${companyId}, ${agentId}, 'automation', 'system', 'resurrection_execution_reconciliation_required', ${sql.json({ issueId: issueBId })}::jsonb, 'queued', NOW() - INTERVAL '10 hours', NOW() - INTERVAL '10 hours', NOW() - INTERVAL '10 hours'),
        -- 5. pending but different reason -> untouched
        (${wakeOtherStatus}, ${companyId}, ${agentId}, 'automation', 'system', 'issue_review_path_lost', ${sql.json({ issueId: issueBId })}::jsonb, 'pending', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours')
    `;

    // Apply migration 0463
    const migrationSql = await readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
    await sql.unsafe(migrationSql);

    // Verify 1: scoped rows requeued as deferred_issue_execution
    const [rowA] = await sql`SELECT "status", "payload" FROM "agent_wakeup_requests" WHERE "id" = ${wakeScopedA}`;
    expect(rowA.status).toBe("deferred_issue_execution");
    expect((rowA.payload as Record<string, unknown>).issueId).toBe(issueAId);

    // Verify 2: empty-string issueId counts as unscoped (NULLIF) -> closed as failed
    const [rowB] = await sql`SELECT "status", "finished_at", "error" FROM "agent_wakeup_requests" WHERE "id" = ${wakeScopedB}`;
    expect(rowB.status).toBe("failed");
    expect(rowB.error).toBe("resurrection_wake_without_issue_scope");
    expect(rowB.finished_at).not.toBeNull();

    // Verify 3: unscoped row closed as failed with the cause preserved
    const [rowUnscoped] = await sql`SELECT "status", "finished_at", "error" FROM "agent_wakeup_requests" WHERE "id" = ${wakeUnscoped}`;
    expect(rowUnscoped.status).toBe("failed");
    expect(rowUnscoped.error).toBe("resurrection_wake_without_issue_scope");
    expect(rowUnscoped.finished_at).not.toBeNull();

    // Verify 4: non-pending row with the same reason untouched
    const [rowOtherReason] = await sql`SELECT "status" FROM "agent_wakeup_requests" WHERE "id" = ${wakeOtherReason}`;
    expect(rowOtherReason.status).toBe("queued");

    // Verify 5: pending row with a different reason untouched
    const [rowOtherStatus] = await sql`SELECT "status" FROM "agent_wakeup_requests" WHERE "id" = ${wakeOtherStatus}`;
    expect(rowOtherStatus.status).toBe("pending");

    // Verify 6: no pending resurrection rows remain for this agent
    const residue = await sql`
      SELECT count(*) AS n FROM "agent_wakeup_requests"
      WHERE "agent_id" = ${agentId}
        AND "status" = 'pending'
        AND "reason" = 'resurrection_execution_reconciliation_required'
    `;
    expect(Number(residue[0].n)).toBe(0);
  }, 60_000);
});
