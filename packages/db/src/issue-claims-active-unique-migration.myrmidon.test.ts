// 1.6.5 (OPE-5401 ч.A / SWARM-CLAIM-UNIQUE-INDEX): the migration test for
// 0308_issue_claims_active_unique.sql — the same style as
// built-in-agent-unique-marker-migration.test.ts: boot the embedded Postgres,
// rewind the migration, seed the pre-index (duplicate) state the claim race
// left behind, re-apply, and assert both halves of the contract:
//
//   1. the duplicate repair keeps the EARLIEST live claim per issue and
//      releases the later ones (with the audit trail intact);
//   2. the partial unique index exists afterwards and rejects a second live
//      claim on the same issue with SQLSTATE 23505 — the error the capture
//      path maps to «занято».
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0308_issue_claims_active_unique.sql";
const UNIQUE_INDEX = "issue_claims_issue_active_uq";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("issue_claims active-claim unique migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("releases duplicate live claims, keeps the earliest, enforces uniqueness", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-issue-claims-active-uq-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind the migration so we can seed the pre-index (duplicate) state.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP INDEX IF EXISTS ${sql(UNIQUE_INDEX)}`;

    const companyId = randomUUID();
    const agentOne = randomUUID();
    const agentTwo = randomUUID();
    const racedIssue = randomUUID();
    const cleanIssue = randomUUID();
    const keeperClaim = randomUUID();
    const staleClaim = randomUUID();
    const tieLeft = randomUUID();
    const tieRight = randomUUID();
    const cleanClaim = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Swarm Race Co', 'SRC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status", "adapter_type", "adapter_config", "runtime_config", "permissions")
      VALUES
        (${agentOne}, ${companyId}, 'agent-one', 'idle', 'paperclip_runner', '{}', '{}', '{}'),
        (${agentTwo}, ${companyId}, 'agent-two', 'idle', 'paperclip_runner', '{}', '{}', '{}')
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "status", "priority")
      VALUES
        (${racedIssue}, ${companyId}, 'issue two live claims raced', 'in_progress', 'high'),
        (${cleanIssue}, ${companyId}, 'issue with one live claim', 'in_progress', 'high')
    `;
    await sql`
      INSERT INTO "issue_claims" ("id", "company_id", "issue_id", "agent_id", "role", "claimed_at", "heartbeat_at", "expires_at", "released_at")
      VALUES
        (${keeperClaim}, ${companyId}, ${racedIssue}, ${agentOne}, 'engineer', '2026-10-05T10:00:00Z', '2026-10-05T10:30:00Z', '2026-10-06T10:00:00Z', NULL),
        (${staleClaim},  ${companyId}, ${racedIssue}, ${agentTwo}, 'engineer', '2026-10-05T11:00:00Z', '2026-10-05T11:00:00Z', '2026-10-06T11:00:00Z', NULL),
        (${tieLeft},     ${companyId}, ${cleanIssue}, ${agentOne}, 'engineer', '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z', '2026-10-06T09:00:00Z', NULL),
        (${tieRight},    ${companyId}, ${cleanIssue}, ${agentTwo}, 'engineer', '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z', '2026-10-06T09:00:00Z', NULL),
        (${cleanClaim},  ${companyId}, ${cleanIssue}, ${agentOne}, 'engineer', '2026-10-04T08:00:00Z', '2026-10-04T08:00:00Z', '2026-10-05T08:00:00Z', '2026-10-05T08:00:00Z')
    `;

    // Re-run the migration: release the duplicate live rows, then create the index.
    await applyPendingMigrations(database.connectionString);

    const claims = await sql<{ id: string; released_at: Date | null; release_reason: string | null }[]>`
      SELECT "id", "released_at", "release_reason" FROM "issue_claims"
    `;
    const byId = new Map(claims.map((row) => [row.id, row]));

    // Earliest per issue stays live; the duplicates are released with their audit reason.
    expect(byId.get(keeperClaim)!.released_at).toBeNull();
    expect(byId.get(staleClaim)!.released_at).not.toBeNull();
    expect(byId.get(staleClaim)!.release_reason).toBe("migration_dedup_0308");
    // Same claimed_at tie is broken deterministically by the smaller id.
    expect(byId.get(tieLeft)!.released_at).toBeNull();
    expect(byId.get(tieRight)!.released_at).not.toBeNull();
    // An already-released historical row is untouched.
    expect(byId.get(cleanClaim)!.release_reason).toBeNull();

    // The partial unique index exists and now rejects a second live claim.
    const indexes = await sql<{ indexname: string }[]>`
      SELECT "indexname" FROM "pg_indexes"
      WHERE "tablename" = 'issue_claims' AND "indexname" = ${UNIQUE_INDEX}
    `;
    expect(indexes).toHaveLength(1);

    await expect(
      sql`
        INSERT INTO "issue_claims" ("id", "company_id", "issue_id", "agent_id", "role", "claimed_at", "heartbeat_at", "expires_at", "released_at")
        VALUES (${randomUUID()}, ${companyId}, ${racedIssue}, ${agentTwo}, 'engineer', now(), now(), now() + interval '1 hour', NULL)
      `,
    ).rejects.toMatchObject({ code: "23505", constraint_name: UNIQUE_INDEX });

    // A second claim on the SAME issue is allowed once the first is released.
    await sql`
      UPDATE "issue_claims" SET "released_at" = now(), "release_reason" = 'run_finished'
      WHERE "id" = ${keeperClaim}
    `;
    await sql`
      INSERT INTO "issue_claims" ("id", "company_id", "issue_id", "agent_id", "role", "claimed_at", "heartbeat_at", "expires_at", "released_at")
      VALUES (${randomUUID()}, ${companyId}, ${racedIssue}, ${agentOne}, 'engineer', now(), now(), now() + interval '1 hour', NULL)
    `;
  }, 30_000);
});
