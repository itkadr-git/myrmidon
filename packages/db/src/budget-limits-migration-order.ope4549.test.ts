import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

// myrmidon(OPE-4549): 0312_budget_limits (numbered 0309 on main, 0307 in an earlier port draft, renumbered for
// the 1.6.5 release branch whose last migration is 0309) must apply cleanly on
// top of 0309_db_care_lz4_compression, with no migration skipped.
describePostgres("budget limits migration order (OPE-4549)", () => {
  it("applies 0312 after 0309 on a fresh database with no skipped migration", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-ope4549-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // startEmbeddedPostgresTestDatabase already applied every migration in
      // journal order; a skipped 0312 would leave budget_limits absent.
      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('budget_limits', 'budget_limit_changes')
        ORDER BY table_name`;
      expect(tables.map((t) => t.table_name)).toEqual([
        "budget_limit_changes",
        "budget_limits",
      ]);
      const applied = await inspectMigrations(database.connectionString);
      const tags = "appliedMigrations" in applied ? applied.appliedMigrations : [];
      expect(tags).toContain("0309_db_care_lz4_compression.sql");
      expect(tags).toContain("0312_budget_limits.sql");
      expect(tags.indexOf("0312_budget_limits.sql")).toBeGreaterThan(tags.indexOf("0309_db_care_lz4_compression.sql"));
      expect(applied.status).toBe("upToDate");
      // sanity: unique index and FK landed
      const idx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='budget_limits'`;
      expect(idx.map((i) => i.indexname)).toContain("budget_limits_company_level_ref_uq");
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 60_000);
});
