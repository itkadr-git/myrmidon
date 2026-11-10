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
//    which is the acceptance criterion of this task). A database read
//    FAILURE is neither of those: read failures propagate, so they can never
//    widen what a company is allowed to do (fail-open on quota). This is the
//    contract pinned by the changes-requested review on PR #2712: a swallowed
//    count failure silently reported 0 active agents, and a swallowed
//    tier-lookup failure silently applied the free/5 default.
//
// Every method answers only from rows the database actually returned; there
// is no catch that converts an error into a permissive result.

import { and, count, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { agents } from "@myrmidon/db";
import type { CompanyTierInfo, CompanyTierReader } from "../application/ports.js";

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

// Postgres SQLSTATE 42704 (undefined_object): raised by to_regclass on old
// drivers/encodings where the "NULL for a missing relation" contract does not
// hold, instead of returning a row with `deployed = false`. Genuinely absent
// table — distinct from a transport failure, which must propagate.
function isUndefinedObjectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code === "42704") return true;
  return err instanceof Error && /undefined_object/i.test(err.message);
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
      } catch (err: unknown) {
        if (isUndefinedObjectError(err)) {
          // to_regclass raised undefined_object (42704): the database is
          // reachable and genuinely has no company_tiers table — the 1.7
          // TIER-SCHEMA (OPE-12091) migration is not deployed here. The
          // quota check stays dormant on such instances (no surprise 403).
          return false;
        }
        // Real failures (connection refused, permissions, driver bugs) must
        // NOT look like "schema not deployed": swallowing them would silently
        // disable quota enforcement. Let them propagate — a read failure may
        // never widen what a company is allowed to do.
        throw err;
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
      } catch (err: unknown) {
        // Every failure here propagates: null must mean only "the company
        // genuinely has no tier row". A swallowed error (connection failure,
        // undeployed table) would be read as an absent tier and silently
        // apply the free/5 default — a read failure may never widen what a
        // company is allowed to do. Callers are required to call
        // isSchemaDeployed() first and skip this read while it returns false,
        // so an undeployed table never reaches this query in production flow;
        // surfacing the error keeps deployment-order mistakes visible.
        throw err;
      }
    },

    async countActiveAgents(companyId: string): Promise<number> {
      if (!db?.select) return 0;
      const rows = await db
        .select({ value: count() })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      return Number(rows[0]?.value ?? 0);
    },
  };
}
