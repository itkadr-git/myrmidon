// 1.6.5 (F-27 PHEROMONE, review #1047 п.6): the migration test for
// 0383_issues_caste_key_and_pheromone_backfill.sql — same style as
// issue-claims-active-unique-migration.myrmidon.test.ts: boot the embedded
// Postgres, rewind the migration, seed the pre-migration state, re-apply and
// assert the contract:
//
//   1. `pheromone_strength` is backfilled from `priority` for rows still at the
//      column default 0 (critical 100 / high 30 / medium 10 / low 1, unknown 10)
//      and a strength an operator already set (non-zero) is kept;
//   2. a `role:<key>` label is lifted into `issues.caste_key` only when the key
//      exists in the company's caste directory; the label itself stays;
//   3. `projects.default_caste_key` and `issues_company_caste_idx` exist.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0383_issues_caste_key_and_pheromone_backfill.sql";
const CASTE_INDEX = "issues_company_caste_idx";
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

describeEmbeddedPostgres("issues caste_key + pheromone backfill migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("backfills strength from priority, lifts role labels to existing castes, adds the columns and the index", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-issues-caste-key-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind the migration so the pre-0383 state can be seeded.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP INDEX IF EXISTS ${sql(CASTE_INDEX)}`;
    await sql`ALTER TABLE "issues" DROP COLUMN "caste_key"`;
    await sql`ALTER TABLE "projects" DROP COLUMN "default_caste_key"`;

    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Caste Co', 'CST'), (${otherCompanyId}, 'Other Co', 'OTH')
    `;
    // The directory: `reviewer` exists in the first company, `ghost` nowhere,
    // `qa` only in the OTHER company (a label must not borrow another tenant's caste).
    await sql`
      INSERT INTO "agent_castes" ("company_id", "key", "name_en")
      VALUES (${companyId}, 'reviewer', 'Reviewer'), (${otherCompanyId}, 'qa', 'QA')
    `;

    const ids = {
      critical: randomUUID(),
      high: randomUUID(),
      medium: randomUUID(),
      low: randomUUID(),
      unknown: randomUUID(),
      kept: randomUUID(),
      withReviewer: randomUUID(),
      withGhost: randomUUID(),
      withForeign: randomUUID(),
      noLabel: randomUUID(),
    };
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "status", "priority", "pheromone_strength")
      VALUES
        (${ids.critical}, ${companyId}, 'critical', 'todo', 'critical', 0),
        (${ids.high}, ${companyId}, 'high', 'todo', 'high', 0),
        (${ids.medium}, ${companyId}, 'medium', 'todo', 'medium', 0),
        (${ids.low}, ${companyId}, 'low', 'todo', 'low', 0),
        (${ids.unknown}, ${companyId}, 'unknown priority', 'todo', 'urgent', 0),
        (${ids.kept}, ${companyId}, 'operator set 77', 'todo', 'low', 77),
        (${ids.withReviewer}, ${companyId}, 'reviewer label', 'todo', 'medium', 0),
        (${ids.withGhost}, ${companyId}, 'ghost label', 'todo', 'medium', 0),
        (${ids.withForeign}, ${companyId}, 'foreign caste label', 'todo', 'medium', 0),
        (${ids.noLabel}, ${companyId}, 'no label', 'todo', 'medium', 0)
    `;
    const labelReviewer = randomUUID();
    const labelGhost = randomUUID();
    const labelForeign = randomUUID();
    await sql`
      INSERT INTO "labels" ("id", "company_id", "name", "color")
      VALUES
        (${labelReviewer}, ${companyId}, 'Role:Reviewer', '#111111'),
        (${labelGhost}, ${companyId}, 'role:ghost', '#222222'),
        (${labelForeign}, ${companyId}, 'role:qa', '#333333')
    `;
    await sql`
      INSERT INTO "issue_labels" ("issue_id", "label_id", "company_id")
      VALUES
        (${ids.withReviewer}, ${labelReviewer}, ${companyId}),
        (${ids.withGhost}, ${labelGhost}, ${companyId}),
        (${ids.withForeign}, ${labelForeign}, ${companyId})
    `;

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{ id: string; pheromone_strength: number; caste_key: string | null }[]>`
      SELECT "id", "pheromone_strength", "caste_key" FROM "issues" WHERE "company_id" = ${companyId}
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));

    // 1) backfill from priority; a deliberate non-zero strength is kept
    expect(byId.get(ids.critical)!.pheromone_strength).toBe(100);
    expect(byId.get(ids.high)!.pheromone_strength).toBe(30);
    expect(byId.get(ids.medium)!.pheromone_strength).toBe(10);
    expect(byId.get(ids.low)!.pheromone_strength).toBe(1);
    expect(byId.get(ids.unknown)!.pheromone_strength).toBe(10);
    expect(byId.get(ids.kept)!.pheromone_strength).toBe(77);

    // 2) labels lifted only for a caste the company really has
    expect(byId.get(ids.withReviewer)!.caste_key).toBe("reviewer");
    expect(byId.get(ids.withGhost)!.caste_key).toBeNull();
    expect(byId.get(ids.withForeign)!.caste_key).toBeNull();
    expect(byId.get(ids.noLabel)!.caste_key).toBeNull();
    const labelRows = await sql`SELECT 1 FROM "issue_labels" WHERE "issue_id" = ${ids.withReviewer}`;
    expect(labelRows).toHaveLength(1); // the label stays: other people's data is not deleted

    // 3) the project column and the routing index exist
    const projectColumn = await sql`
      SELECT 1 FROM "information_schema"."columns"
      WHERE "table_name" = 'projects' AND "column_name" = 'default_caste_key'
    `;
    expect(projectColumn).toHaveLength(1);
    const index = await sql`
      SELECT 1 FROM "pg_indexes" WHERE "tablename" = 'issues' AND "indexname" = ${CASTE_INDEX}
    `;
    expect(index).toHaveLength(1);
  }, 60_000);
});
