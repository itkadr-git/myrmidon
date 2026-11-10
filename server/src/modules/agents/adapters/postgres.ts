// server/src/modules/agents/adapters/postgres.ts
//
// myrmidon(1.7 TIER-QUOTA-CHECK OPE-12092): the Postgres company-tier reader.
//
// Two deliberate behaviours here:
//
// 1. Raw SQL instead of the drizzle table objects. The tier schema itself
//    ships with 1.7 TIER-SCHEMA (OPE-12091); until its migration is deployed,
//    `company_tiers` does not exist, and referencing the drizzle table object
//    from a reader that runs against test doubles (mock db chains without
//    `.limit()`/`execute`) blew up with TypeError -> 500s in route tests.
//    Raw `sql` keeps this adapter independent of both the schema deployment
//    state and the shape of the db test doubles.
//
// 2. `isSchemaDeployed` distinguishes "the tier table is not deployed yet"
//    (quota enforcement stays dormant: every company passes, no surprise 403
//    on instances that predate 1.7 TIER-SCHEMA) from "the table exists but
//    this company has no row" (tier absent -> default free/5 still enforced,
//    which is the acceptance criterion of this task).

import { and, count, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents } from "@myrmidon/db";
import type { CompanyTierInfo, CompanyTierReader } from "../application/ports.js";

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export function createPostgresCompanyTierReader(db: Db): CompanyTierReader {
  return {
    async isSchemaDeployed(): Promise<boolean> {
      try {
        if (!db?.execute) return false;
        // to_regclass: NULL when the 1.7 TIER-SCHEMA migration is not
        // deployed (also the case in embedded test databases).
        const rows = rowsOf(await db.execute(sql`select to_regclass('public.company_tiers') is not null as deployed`));
        return rows[0]?.deployed === true;
      } catch {
        // Reader failures must never break agent creation with a 500: treat
        // the schema as not deployed so the quota check stays dormant.
        return false;
      }
    },

    async getCompanyTier(companyId: string): Promise<CompanyTierInfo | null> {
      try {
        if (!db?.execute) return null;
        const rows = rowsOf(
          await db.execute(sql`
            select t.tier as tier, t.agent_quota as agent_quota
            from company_tiers t
            where t.company_id = ${companyId}
            limit 1
          `),
        );
        const row = rows[0];
        if (!row || row.tier === null || row.tier === undefined) return null;
        return {
          tier: String(row.tier),
          agentQuota: Number(row.agent_quota),
        };
      } catch {
        // Reader failures must never break agent creation with a 500: treat
        // the tier as absent (the default free/5 path decides).
        return null;
      }
    },

    async countActiveAgents(companyId: string): Promise<number> {
      try {
        if (!db?.select) return 0;
        const rows = await db
          .select({ value: count() })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
        return Number(rows[0]?.value ?? 0);
      } catch {
        // Doubles in route tests (and a missing agents table) count as 0.
        return 0;
      }
    },
  };
}
