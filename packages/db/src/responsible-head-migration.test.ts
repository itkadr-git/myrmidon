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

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(new URL("./migrations/0422_colorful_jazinda.sql", import.meta.url)),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("migration 0422 responsible head backfill", () => {
  it("populates responsible_agent_id and clears responsible_user_id for bot issues, leaving human-created issues intact", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("resp-head-migration-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await sql.end();
    });

    const companyId = randomUUID();
    const ownerUserId = randomUUID();
    const admId = randomUUID();
    const leadDevId = randomUUID();
    const eng23Id = randomUUID();
    const pausedRootId = randomUUID();
    const projectId = randomUUID();

    const humanIssueId = randomUUID();
    const botIssueAssignedId = randomUUID();
    const botIssueProjectId = randomUUID();
    const botIssueCompanyRootId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Resp Head Co', 'RHC')
    `;

    // Insert root adm (active)
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type")
      VALUES (${admId}, ${companyId}, 'adm', 'lead', 'active', 'process')
    `;

    // Insert paused root (must be skipped)
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "adapter_type")
      VALUES (${pausedRootId}, ${companyId}, 'Wiki Maintainer', 'librarian', 'paused', 'process')
    `;

    // Insert leadDev (reports to adm)
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "reports_to", "adapter_type")
      VALUES (${leadDevId}, ${companyId}, 'lead-dev', 'lead', 'active', ${admId}, 'process')
    `;

    // Insert eng23 (reports to leadDev)
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "status", "reports_to", "adapter_type")
      VALUES (${eng23Id}, ${companyId}, 'eng-23', 'engineer', 'active', ${leadDevId}, 'process')
    `;

    // Insert project with lead_agent_id = leadDevId
    await sql`
      INSERT INTO "projects" ("id", "company_id", "name", "lead_agent_id")
      VALUES (${projectId}, ${companyId}, 'Dev project', ${leadDevId})
    `;

    // 1. Human-created issue: created_by_user_id is set, created_by_agent_id is null, responsible_user_id is owner
    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "identifier", "status", "priority",
        "created_by_user_id", "created_by_agent_id", "responsible_user_id", "responsible_agent_id"
      ) VALUES (
        ${humanIssueId}, ${companyId}, 'Human created task', 'RHC-1', 'in_progress', 'medium',
        ${ownerUserId}, NULL, ${ownerUserId}, NULL
      )
    `;

    // 2. Bot issue with assignee eng23 (reports to lead-dev -> adm)
    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "identifier", "status", "priority",
        "created_by_user_id", "created_by_agent_id", "assignee_agent_id", "responsible_user_id", "responsible_agent_id"
      ) VALUES (
        ${botIssueAssignedId}, ${companyId}, 'Bot assigned task', 'RHC-2', 'in_progress', 'medium',
        NULL, ${eng23Id}, ${eng23Id}, ${ownerUserId}, NULL
      )
    `;

    // 3. Bot issue with project (lead-dev -> adm), unassigned
    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "identifier", "status", "priority",
        "created_by_user_id", "created_by_agent_id", "project_id", "responsible_user_id", "responsible_agent_id"
      ) VALUES (
        ${botIssueProjectId}, ${companyId}, 'Bot project task', 'RHC-3', 'in_progress', 'medium',
        NULL, ${eng23Id}, ${projectId}, ${ownerUserId}, NULL
      )
    `;

    // 4. Bot issue unassigned without project -> should get default company root (admId, not pausedRootId)
    await sql`
      INSERT INTO "issues" (
        "id", "company_id", "title", "identifier", "status", "priority",
        "created_by_user_id", "created_by_agent_id", "responsible_user_id", "responsible_agent_id"
      ) VALUES (
        ${botIssueCompanyRootId}, ${companyId}, 'Bot default root task', 'RHC-4', 'in_progress', 'medium',
        NULL, ${eng23Id}, ${ownerUserId}, NULL
      )
    `;

    // Run the migration statements
    const stmts = await migrationStatements();
    // In test DB, DDL (ALTER TABLE, CREATE INDEX) might already be present from db init.
    // Run the backfill statement (the last one containing UPDATE issues)
    const backfillStmt = stmts.find((s) => s.includes("UPDATE issues"));
    expect(backfillStmt).toBeDefined();
    await sql.unsafe(backfillStmt!);

    // Verify 1. Human issue: intact
    const [humanRow] = await sql<[{ responsible_user_id: string | null; responsible_agent_id: string | null }]>`
      SELECT responsible_user_id, responsible_agent_id FROM "issues" WHERE "id" = ${humanIssueId}
    `;
    expect(humanRow.responsible_user_id).toBe(ownerUserId);
    expect(humanRow.responsible_agent_id).toBeNull();

    // Verify 2. Bot assigned issue: responsible_agent_id = admId, responsible_user_id = null
    const [assignedRow] = await sql<[{ responsible_user_id: string | null; responsible_agent_id: string | null }]>`
      SELECT responsible_user_id, responsible_agent_id FROM "issues" WHERE "id" = ${botIssueAssignedId}
    `;
    expect(assignedRow.responsible_agent_id).toBe(admId);
    expect(assignedRow.responsible_user_id).toBeNull();

    // Verify 3. Bot project issue: responsible_agent_id = admId, responsible_user_id = null
    const [projectRow] = await sql<[{ responsible_user_id: string | null; responsible_agent_id: string | null }]>`
      SELECT responsible_user_id, responsible_agent_id FROM "issues" WHERE "id" = ${botIssueProjectId}
    `;
    expect(projectRow.responsible_agent_id).toBe(admId);
    expect(projectRow.responsible_user_id).toBeNull();

    // Verify 4. Bot default root issue: responsible_agent_id = admId (paused root was skipped), responsible_user_id = null
    const [defaultRow] = await sql<[{ responsible_user_id: string | null; responsible_agent_id: string | null }]>`
      SELECT responsible_user_id, responsible_agent_id FROM "issues" WHERE "id" = ${botIssueCompanyRootId}
    `;
    expect(defaultRow.responsible_agent_id).toBe(admId);
    expect(defaultRow.responsible_user_id).toBeNull();
  });
});
