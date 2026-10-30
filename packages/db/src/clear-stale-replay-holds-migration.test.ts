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

  it("deduplicates historical holds, clears >24h stale holds on workable issues, and protects ineligible rows", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-migration-0422-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Apply baseline migrations
    await applyPendingMigrations(database.connectionString);

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Migration Test Co', 'MTC')`;

    // 1. Issue with duplicate historical holds: rank 1 (<24h) and rank 2 (older duplicate)
    const issue1Id = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issue1Id}, ${companyId}, 'issue with duplicates', 'todo', 'high')`;
    const actionDedupe1 = randomUUID();
    const actionDedupe2 = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES
        (${actionDedupe1}, ${companyId}, ${issue1Id}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),
        (${actionDedupe2}, ${companyId}, ${issue1Id}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '5 hours', NOW() - INTERVAL '5 hours')
    `;

    // 2. Workable issue (>24h hold) -> should be cleared by stale branch
    const issueStaleId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueStaleId}, ${companyId}, 'stale workable issue', 'todo', 'medium')`;
    const actionStale = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionStale}, ${companyId}, ${issueStaleId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 3. Protected: issue is 'blocked' (>24h hold) -> should NOT be cleared by stale branch
    const issueBlockedId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueBlockedId}, ${companyId}, 'blocked issue', 'blocked', 'medium')`;
    const actionBlocked = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionBlocked}, ${companyId}, ${issueBlockedId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 4. Protected: issue is 'in_review' (>24h hold) -> should NOT be cleared by stale branch
    const issueInReviewId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueInReviewId}, ${companyId}, 'in_review issue', 'in_review', 'medium')`;
    const actionInReview = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionInReview}, ${companyId}, ${issueInReviewId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 5. Protected: issue is 'done' (>24h hold) -> should NOT be cleared by stale branch
    const issueDoneId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueDoneId}, ${companyId}, 'done issue', 'done', 'low')`;
    const actionDone = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionDone}, ${companyId}, ${issueDoneId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 6. Protected: issue has unblock_descriptor (>24h hold) -> should NOT be cleared by stale branch
    const issueDescId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority", "unblock_descriptor") VALUES (${issueDescId}, ${companyId}, 'issue with unblock descriptor', 'todo', 'medium', '{"reason":"waiting on approval"}'::jsonb)`;
    const actionDesc = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionDesc}, ${companyId}, ${issueDescId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 7. Protected: issue has pending thread interaction (>24h hold) -> should NOT be cleared by stale branch
    const issueInterId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueInterId}, ${companyId}, 'issue with interaction', 'in_progress', 'medium')`;
    const interId = randomUUID();
    await sql`
      INSERT INTO "issue_thread_interactions" ("id", "company_id", "issue_id", "status", "kind", "payload")
      VALUES (${interId}, ${companyId}, ${issueInterId}, 'pending', 'request_confirmation', '{"version": 1, "prompt": "confirm?"}'::jsonb)
    `;
    const actionInter = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionInter}, ${companyId}, ${issueInterId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 8. Protected: issue has open blocker relation (>24h hold) -> should NOT be cleared by stale branch
    const issueBlockedById = randomUUID();
    const blockerIssueId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${blockerIssueId}, ${companyId}, 'blocker issue', 'todo', 'high')`;
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueBlockedById}, ${companyId}, 'blocked-by-issue issue', 'todo', 'medium')`;
    await sql`
      INSERT INTO "issue_relations" ("id", "company_id", "issue_id", "related_issue_id", "type")
      VALUES (${randomUUID()}, ${companyId}, ${blockerIssueId}, ${issueBlockedById}, 'blocks')
    `;
    const actionBlockedBy = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionBlockedBy}, ${companyId}, ${issueBlockedById}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 9. Protected: action status is 'active' (not resolved/cancelled) -> should NOT be cleared by stale branch
    const issueActiveActionId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueActiveActionId}, ${companyId}, 'active recovery action issue', 'todo', 'medium')`;
    const actionActive = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionActive}, ${companyId}, ${issueActiveActionId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'active', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '25 hours', NOW() - INTERVAL '25 hours')
    `;

    // 10. Protected: action is <24h old (2 hours old) on open issue -> should NOT be cleared by stale branch
    const issueRecentId = randomUUID();
    await sql`INSERT INTO "issues" ("id", "company_id", "title", "status", "priority") VALUES (${issueRecentId}, ${companyId}, 'recent hold issue', 'todo', 'medium')`;
    const actionRecent = randomUUID();
    await sql`
      INSERT INTO "issue_recovery_actions" ("id", "company_id", "source_issue_id", "kind", "cause", "fingerprint", "next_action", "status", "evidence", "created_at", "updated_at")
      VALUES (${actionRecent}, ${companyId}, ${issueRecentId}, 'execution_reconciliation', 'uncertain_provider_action', ${randomUUID()}, 'hold', 'resolved', '{"automaticRecovery": {"replay": "blocked"}}'::jsonb, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours')
    `;

    // Apply migration 0422
    const migrationSql = await readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
    await sql.unsafe(migrationSql);

    // Verify 1: Deduplication branch
    const [rowDedup1] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionDedupe1}`;
    expect((rowDedup1.evidence as any).automaticRecovery.replay).toBe("blocked"); // rank 1 kept as-is

    const [rowDedup2] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionDedupe2}`;
    expect((rowDedup2.evidence as any).automaticRecovery.replay).toBe("cleared");
    expect((rowDedup2.evidence as any).automaticRecovery.replayClearedBy).toBe("migration_0422_dedupe");
    expect((rowDedup2.evidence as any).automaticRecovery.previousEvidence).toEqual({ automaticRecovery: { replay: "blocked" } });

    // Verify 2: Stale (>24h) branch on safe workable issue
    const [rowStale] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionStale}`;
    expect((rowStale.evidence as any).automaticRecovery.replay).toBe("cleared");
    expect((rowStale.evidence as any).automaticRecovery.replayClearedBy).toBe("migration_0422_stale");
    expect((rowStale.evidence as any).automaticRecovery.previousEvidence).toEqual({ automaticRecovery: { replay: "blocked" } });

    // Verify 3: Protected rows remained untouched
    const [rowBlocked] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionBlocked}`;
    expect((rowBlocked.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowInReview] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionInReview}`;
    expect((rowInReview.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowDone] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionDone}`;
    expect((rowDone.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowDesc] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionDesc}`;
    expect((rowDesc.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowInter] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionInter}`;
    expect((rowInter.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowBlockedBy] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionBlockedBy}`;
    expect((rowBlockedBy.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowActive] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionActive}`;
    expect((rowActive.evidence as any).automaticRecovery.replay).toBe("blocked");

    const [rowRecent] = await sql`SELECT "evidence" FROM "issue_recovery_actions" WHERE "id" = ${actionRecent}`;
    expect((rowRecent.evidence as any).automaticRecovery.replay).toBe("blocked");

    // Verify 4: Durable activity_log entries
    const auditRows = await sql`SELECT * FROM "activity_log" WHERE "actor_id" = 'migration_0422' AND "action" = 'issue.execution_recovery_settled'`;
    expect(auditRows.length).toBe(2);

    const dedupeAudit = auditRows.find((r) => (r.details as any).actionId === actionDedupe2);
    expect(dedupeAudit).toBeDefined();
    expect((dedupeAudit!.details as any).reason).toContain("migration_0422_dedupe");
    expect((dedupeAudit!.details as any).previousEvidence).toEqual({ automaticRecovery: { replay: "blocked" } });

    const staleAudit = auditRows.find((r) => (r.details as any).actionId === actionStale);
    expect(staleAudit).toBeDefined();
    expect((staleAudit!.details as any).reason).toContain("migration_0422_stale");
    expect((staleAudit!.details as any).previousEvidence).toEqual({ automaticRecovery: { replay: "blocked" } });
  }, 30_000);
});
