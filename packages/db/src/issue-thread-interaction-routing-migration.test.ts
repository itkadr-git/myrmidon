import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL("./migrations/0422_interaction_routing.sql", import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("issue thread interaction routing migration (0422)", () => {
  it(
    "supports double application, preserves old rows, enforces check constraints, and creates index",
    async () => {
      const dbh = await startEmbeddedPostgresTestDatabase("interaction-routing-migration-");
      cleanups.push(() => dbh.cleanup());
      const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => {
        await sql.end();
      });

      const companyId = randomUUID();
      const issueId = randomUUID();
      const agentId = randomUUID();
      const userId = randomUUID();

      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Routing Migration Co', 'RMC')
      `;
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${issueId}, ${companyId}, 'Test interaction routing', 'RMC-1')
      `;
      await sql`
        INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type", "adapter_config", "runtime_config", "permissions")
        VALUES (${agentId}, ${companyId}, 'Router Agent', 'engineer', 'idle', 'codex_local', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
      `;

      // 1. Insert existing legacy rows (route_type IS NULL)
      const legacyInteractionId = randomUUID();
      await sql`
        INSERT INTO "issue_thread_interactions" (
          "id",
          "company_id",
          "issue_id",
          "kind",
          "status",
          "addressee_agent_id",
          "payload"
        )
        VALUES (
          ${legacyInteractionId},
          ${companyId},
          ${issueId},
          'request_confirmation',
          'pending',
          ${agentId},
          '{}'::jsonb
        )
      `;

      // 2. Двойное применение (idempotent replay)
      const statements = await migrationStatements();
      expect(statements.length).toBeGreaterThan(0);

      // First run
      for (const statement of statements) {
        await sql.unsafe(statement);
      }

      // Second run (re-apply)
      for (const statement of statements) {
        await sql.unsafe(statement);
      }

      // 3. Старые строки целы
      const legacyRows = await sql<{
        id: string;
        route_type: string | null;
        addressee_queue: string | null;
        timeout_at: Date | null;
        escalation_chain: unknown;
        escalation_level: number;
      }[]>`
        SELECT
          "id",
          "route_type",
          "addressee_queue",
          "timeout_at",
          "escalation_chain",
          "escalation_level"
        FROM "issue_thread_interactions"
        WHERE "id" = ${legacyInteractionId}
      `;
      expect(legacyRows).toHaveLength(1);
      expect(legacyRows[0].id).toBe(legacyInteractionId);
      expect(legacyRows[0].route_type).toBeNull();
      expect(legacyRows[0].addressee_queue).toBeNull();
      expect(legacyRows[0].timeout_at).toBeNull();
      expect(legacyRows[0].escalation_chain).toBeNull();
      expect(legacyRows[0].escalation_level).toBe(0);

      // 4. CHECK constraint tests
      // Case A: route_type without any addressee -> should fail CHECK
      const noAddresseeId = randomUUID();
      await expect(
        sql`
          INSERT INTO "issue_thread_interactions" (
            "id",
            "company_id",
            "issue_id",
            "kind",
            "status",
            "route_type",
            "timeout_at",
            "payload"
          )
          VALUES (
            ${noAddresseeId},
            ${companyId},
            ${issueId},
            'request_confirmation',
            'pending',
            'agent',
            now() + interval '1 hour',
            '{}'::jsonb
          )
        `,
      ).rejects.toThrow();

      // Case B: route_type with two addressees (agent + user) -> should fail CHECK
      const twoAddresseesId = randomUUID();
      await expect(
        sql`
          INSERT INTO "issue_thread_interactions" (
            "id",
            "company_id",
            "issue_id",
            "kind",
            "status",
            "route_type",
            "addressee_agent_id",
            "addressee_user_id",
            "timeout_at",
            "payload"
          )
          VALUES (
            ${twoAddresseesId},
            ${companyId},
            ${issueId},
            'request_confirmation',
            'pending',
            'agent',
            ${agentId},
            ${userId},
            now() + interval '1 hour',
            '{}'::jsonb
          )
        `,
      ).rejects.toThrow();

      // Case C: route_type with addressee but timeout_at IS NULL -> should fail CHECK
      const noTimeoutId = randomUUID();
      await expect(
        sql`
          INSERT INTO "issue_thread_interactions" (
            "id",
            "company_id",
            "issue_id",
            "kind",
            "status",
            "route_type",
            "addressee_agent_id",
            "timeout_at",
            "payload"
          )
          VALUES (
            ${noTimeoutId},
            ${companyId},
            ${issueId},
            'request_confirmation',
            'pending',
            'agent',
            ${agentId},
            NULL,
            '{}'::jsonb
          )
        `,
      ).rejects.toThrow();

      // Case D: Valid routed interaction with queue addressee and timeout_at
      const validQueueId = randomUUID();
      await sql`
        INSERT INTO "issue_thread_interactions" (
          "id",
          "company_id",
          "issue_id",
          "kind",
          "status",
          "route_type",
          "addressee_queue",
          "timeout_at",
          "escalation_chain",
          "escalation_level",
          "payload"
        )
        VALUES (
          ${validQueueId},
          ${companyId},
          ${issueId},
          'request_confirmation',
          'pending',
          'queue',
          'triage',
          now() + interval '30 minutes',
          '[{"level": 1, "target": "lead"}]'::jsonb,
          0,
          '{}'::jsonb
        )
      `;
      const queueRow = await sql<{ id: string; addressee_queue: string; route_type: string }[]>`
        SELECT "id", "addressee_queue", "route_type"
        FROM "issue_thread_interactions"
        WHERE "id" = ${validQueueId}
      `;
      expect(queueRow).toHaveLength(1);
      expect(queueRow[0].addressee_queue).toBe("triage");
      expect(queueRow[0].route_type).toBe("queue");

      // 5. Индекс создан
      const indexes = await sql<{ indexname: string; indexdef: string }[]>`
        SELECT "indexname", "indexdef"
        FROM "pg_indexes"
        WHERE "tablename" = 'issue_thread_interactions'
          AND "indexname" = 'issue_thread_interactions_pending_timeout_idx'
      `;
      expect(indexes).toHaveLength(1);
      expect(indexes[0].indexdef).toContain("status");
      expect(indexes[0].indexdef).toContain("timeout_at");
      expect(indexes[0].indexdef).toContain("pending");
    },
    EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );
});
