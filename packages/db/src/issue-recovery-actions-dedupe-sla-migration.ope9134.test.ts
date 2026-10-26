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

const MIGRATION_FILE = "0419_issue_recovery_actions_dedupe_sla.sql";
const DEDUPE_UNIQUE_INDEX = "issue_recovery_actions_active_dedupe_key_uq";
const SOURCE_UNIQUE_INDEX = "issue_recovery_actions_active_source_uq";
const OWNER_SLA_CHECK = "issue_recovery_actions_dedupe_owner_sla_check";

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function dedupeSlaMigrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function insertRecoveryAction(
  sql: postgres.Sql,
  row: {
    companyId: string;
    sourceIssueId: string;
    dedupeKey?: string | null;
    ownerAgentId?: string | null;
    ownerUserId?: string | null;
    ownerQueue?: string | null;
    slaDueAt?: Date | null;
    nextCheckAt?: Date | null;
    status?: string;
    cause?: string;
    fingerprint?: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO "issue_recovery_actions" (
      "company_id",
      "source_issue_id",
      "kind",
      "status",
      "cause",
      "fingerprint",
      "next_action",
      "dedupe_key",
      "owner_agent_id",
      "owner_user_id",
      "owner_queue",
      "sla_due_at",
      "next_check_at"
    )
    VALUES (
      ${row.companyId},
      ${row.sourceIssueId},
      'blocked_recovery',
      ${row.status ?? "active"},
      ${row.cause ?? "ci_failed"},
      ${row.fingerprint ?? randomUUID()},
      'retry',
      ${row.dedupeKey ?? null},
      ${row.ownerAgentId ?? null},
      ${row.ownerUserId ?? null},
      ${row.ownerQueue ?? null},
      ${row.slaDueAt ?? null},
      ${row.nextCheckAt ?? null}
    )
  `;
}

d("issue_recovery_actions dedupe_key/SLA migration (OPE-9134)", () => {
  it(
    "applies twice, keeps one active row per dedupe_key, allows several deduped rows per source, enforces owner+SLA, and leaves legacy rows untouched",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("issue-recovery-dedupe-sla-");
      cleanups.push(() => dbh.cleanup());
      const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => {
        await sql.end();
      });

      const companyId = randomUUID();
      const sourceIssueId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Recovery dedupe migration test', 'RDM')
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${sourceIssueId}, ${companyId}, 'Recovery dedupe source', 'RDM-1')
      `;

      // A legacy active row without dedupe_key must survive the migration.
      const legacyRowId = randomUUID();
      await sql`
        INSERT INTO "issue_recovery_actions" (
          "id", "company_id", "source_issue_id", "kind", "status", "cause", "fingerprint", "next_action"
        )
        VALUES (
          ${legacyRowId}, ${companyId}, ${sourceIssueId}, 'attention_needed', 'active',
          'ci_failed', 'legacy-fingerprint', 'noop'
        )
      `;

      // Apply the migration on top of the already-migrated CI database (idempotent replay).
      const statements = await dedupeSlaMigrationStatements();
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) await sql.unsafe(statement);
      // Second application must be a no-op.
      for (const statement of statements) await sql.unsafe(statement);

      // The recreated active_source_uq must keep protecting legacy rows.
      await expect(
        insertRecoveryAction(sql, {
          companyId,
          sourceIssueId,
          dedupeKey: null,
          ownerAgentId: null,
          ownerUserId: null,
          ownerQueue: null,
        }),
      ).rejects.toMatchObject({ code: "23505", constraint_name: SOURCE_UNIQUE_INDEX });

      const sla = new Date("2026-10-25T12:00:00Z");
      const nextCheck = new Date("2026-10-25T10:00:00Z");
      const agentId = randomUUID();
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name")
        VALUES (${agentId}, ${companyId}, 'Recovery dedupe test agent')
      `;

      // Two active rows with different dedupe keys on the same source issue must pass.
      await insertRecoveryAction(sql, {
        companyId,
        sourceIssueId,
        dedupeKey: "ci:run:1",
        ownerAgentId: agentId,
        slaDueAt: sla,
        nextCheckAt: nextCheck,
      });
      await insertRecoveryAction(sql, {
        companyId,
        sourceIssueId,
        dedupeKey: "ci:run:2",
        ownerQueue: "devops",
        slaDueAt: sla,
        nextCheckAt: nextCheck,
      });

      // A third active row reusing a dedupe key must fail with 23505.
      await expect(
        insertRecoveryAction(sql, {
          companyId,
          sourceIssueId,
          dedupeKey: "ci:run:1",
          ownerUserId: "user-1",
          slaDueAt: sla,
          nextCheckAt: nextCheck,
        }),
      ).rejects.toMatchObject({ code: "23505", constraint_name: DEDUPE_UNIQUE_INDEX });

      // A deduped row without exactly one owner must fail the CHECK.
      await expect(
        insertRecoveryAction(sql, {
          companyId,
          sourceIssueId,
          dedupeKey: "ci:run:3",
          ownerAgentId: null,
          ownerUserId: null,
          ownerQueue: null,
          slaDueAt: sla,
          nextCheckAt: nextCheck,
        }),
      ).rejects.toMatchObject({ code: "23514", constraint_name: OWNER_SLA_CHECK });

      // Two owners also violate "exactly one".
      await expect(
        insertRecoveryAction(sql, {
          companyId,
          sourceIssueId,
          dedupeKey: "ci:run:3",
          ownerAgentId: agentId,
          ownerQueue: "devops",
          slaDueAt: sla,
          nextCheckAt: nextCheck,
        }),
      ).rejects.toMatchObject({ code: "23514", constraint_name: OWNER_SLA_CHECK });

      // A deduped row missing SLA fields must fail the CHECK.
      await expect(
        insertRecoveryAction(sql, {
          companyId,
          sourceIssueId,
          dedupeKey: "ci:run:3",
          ownerAgentId: agentId,
        }),
      ).rejects.toMatchObject({ code: "23514", constraint_name: OWNER_SLA_CHECK });

      // A resolved row with a duplicate dedupe key is allowed to coexist.
      await insertRecoveryAction(sql, {
        companyId,
        sourceIssueId,
        dedupeKey: "ci:run:1",
        ownerAgentId: agentId,
        slaDueAt: sla,
        nextCheckAt: nextCheck,
        status: "resolved",
      });

      const legacyRow = await sql<{ dedupe_key: string | null }[]>`
        SELECT "dedupe_key" FROM "issue_recovery_actions" WHERE "id" = ${legacyRowId}
      `;
      expect(legacyRow).toEqual([{ dedupe_key: null }]);

      const activeByDedupeKey = await sql<{ dedupe_key: string }[]>`
        SELECT "dedupe_key"
        FROM "issue_recovery_actions"
        WHERE "company_id" = ${companyId} AND "status" = 'active'
        ORDER BY "dedupe_key" NULLS FIRST
      `;
      expect(
        activeByDedupeKey.map((row) => row.dedupe_key),
      ).toEqual([null, "ci:run:1", "ci:run:2"]);
    },
    240_000,
  );
});
