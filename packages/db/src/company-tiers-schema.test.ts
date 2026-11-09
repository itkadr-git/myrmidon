import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { companyTiers } from "./schema/company_tiers.js";

// myrmidon(1.7 TIER-SCHEMA OPE-12091): the tier/quota table exists with the
// free-plan defaults; the backfill migration gives every existing company the
// defaults without touching companies that already have a row.

type PgTable = Parameters<typeof getTableConfig>[0];

function column(table: PgTable, columnName: string) {
  return getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
}

function columnDefault(table: PgTable, columnName: string): string | undefined {
  const found = column(table, columnName);
  if (!found) return undefined;
  const config = found as unknown as { default?: unknown; columnType?: string };
  return config.default === undefined ? undefined : String(config.default);
}

const BACKFILL_NUMBER = "0469";

function backfillSql(): string {
  const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const name = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.startsWith(BACKFILL_NUMBER) && file.endsWith(".sql"))
    .sort()
    .at(0);
  if (!name) throw new Error(`no ${BACKFILL_NUMBER} migration found`);
  return fs.readFileSync(path.join(migrationsDir, name), "utf8");
}

describe("company tiers schema (OPE-12091)", () => {
  it("has tier and agent quota columns with free/5 defaults", () => {
    const tier = column(companyTiers, "tier");
    const agentQuota = column(companyTiers, "agent_quota");
    expect(tier).toBeDefined();
    expect(agentQuota).toBeDefined();
    expect(tier?.notNull).toBe(true);
    expect(agentQuota?.notNull).toBe(true);
    expect(columnDefault(companyTiers, "tier")).toContain("free");
    expect(columnDefault(companyTiers, "agent_quota")).toContain("5");
    expect(tier?.dataType).toBe("string");
    expect(agentQuota?.dataType).toBe("number");
  });

  it("has a company foreign key column, unique per company", () => {
    const companyId = column(companyTiers, "company_id");
    expect(companyId).toBeDefined();
    expect(companyId?.notNull).toBe(true);
    const indexes = getTableConfig(companyTiers).indexes.map((index) => index.config.name);
    expect(indexes).toContain("company_tiers_company_id_uq");
  });

  it("migration 0469 backfills every existing company with free/5", () => {
    const sql = backfillSql();
    expect(sql).toContain('INSERT INTO "company_tiers" ("company_id", "tier", "agent_quota")');
    expect(sql.toUpperCase()).toContain("ON CONFLICT");
    expect(sql).toContain("'free'");
    expect(sql).toContain("5");
    // Do not import companies without a row in `companies`.
    expect(sql).toContain("FROM \"companies\"");
  });
});
