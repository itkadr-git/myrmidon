// server/src/modules/agents/adapters/postgres.ts

import type { Db } from "@myrmidon/db";
import { agents, companyTiers } from "@myrmidon/db";
import { and, count, eq, ne } from "drizzle-orm";
import type { CompanyTierInfo, CompanyTierReader } from "../application/ports.js";

export function createPostgresCompanyTierReader(db: Db): CompanyTierReader {
  return {
    async getCompanyTier(companyId: string): Promise<CompanyTierInfo | null> {
      try {
        const rows = await db
          .select({
            tier: companyTiers.tier,
            agentQuota: companyTiers.agentQuota,
          })
          .from(companyTiers)
          .where(eq(companyTiers.companyId, companyId))
          .limit(1);

        return rows[0] ?? null;
      } catch (err: unknown) {
        // When table company_tiers does not yet exist in PostgreSQL
        // (e.g. before migration has run in a test DB), treat tier as absent.
        const pgErr = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
        if (
          pgErr?.code === "42P01" ||
          pgErr?.cause?.code === "42P01" ||
          (typeof pgErr?.message === "string" && pgErr.message.includes("does not exist")) ||
          (typeof pgErr?.cause?.message === "string" && pgErr.cause.message.includes("does not exist"))
        ) {
          return null;
        }
        throw err;
      }
    },

    async countActiveAgents(companyId: string): Promise<number> {
      try {
        const rows = await db
          .select({ value: count() })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));

        return Number(rows[0]?.value ?? 0);
      } catch (err: unknown) {
        const pgErr = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
        if (
          pgErr?.code === "42P01" ||
          pgErr?.cause?.code === "42P01" ||
          (typeof pgErr?.message === "string" && pgErr.message.includes("does not exist")) ||
          (typeof pgErr?.cause?.message === "string" && pgErr.cause.message.includes("does not exist"))
        ) {
          return 0;
        }
        throw err;
      }
    },
  };
}
