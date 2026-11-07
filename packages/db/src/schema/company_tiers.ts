import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// myrmidon(1.7 TIER-SCHEMA OPE-12091): subscription plan of a company plus its
// agent quota. One row per company; existing companies receive the `free` tier
// with a quota of 5 agents (migration 0464 backfill). `updatedAt` is maintained
// by whoever writes the row; the schema itself only stores the plan.
export const companyTiers = pgTable(
  "company_tiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Subscription plan: free | pro | enterprise (text so new plans need no migration)
    tier: text("tier").notNull().default("free"),
    // Maximum concurrently active agents allowed for the company
    agentQuota: integer("agent_quota").notNull().default(5),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdIdx: uniqueIndex("company_tiers_company_id_uq").on(table.companyId),
  }),
);
