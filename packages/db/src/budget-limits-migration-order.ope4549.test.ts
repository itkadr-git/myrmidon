import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

// myrmidon(OPE-4549): the renumbered 0309_budget_limits must apply cleanly on
// top of 0308_agent_exchange_rooms (the main-branch ordering), with no
// migration skipped and both feature table sets present.
describePostgres("budget limits migration order (OPE-4549)", () => {
  it("applies 0309 after 0308 on a fresh database with no skipped migration", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-ope4549-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // startEmbeddedPostgresTestDatabase already applied every migration in
      // journal order; a skipped 0309 would leave budget_limits absent.
      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('budget_limits', 'budget_limit_changes', 'model_providers', 'model_provider_models')
        ORDER BY table_name`;
      expect(tables.map((t) => t.table_name)).toEqual([
        "budget_limit_changes",
        "budget_limits",
        "model_provider_models",
        "model_providers",
      ]);
      const applied = await inspectMigrations(database.connectionString);
      const tags = "appliedMigrations" in applied ? applied.appliedMigrations : [];
      expect(tags).toContain("0308_agent_exchange_rooms.sql");
      expect(tags).toContain("0309_budget_limits.sql");
      expect(tags.indexOf("0309_budget_limits.sql")).toBeGreaterThan(tags.indexOf("0308_agent_exchange_rooms.sql"));
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
