import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * myrmidon(1.6.6 REMOTE-SITES-T5): fleet affinity rules.
 *
 * Maps projects, companies, or specific agents to preferred execution sites with priority weights.
 * Priority order: manual pin > affinity > capacity.
 */
export const myrmidonFleetAffinity = pgTable(
  "myrmidon_fleet_affinity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(), // "project" | "company" | "agent"
    targetId: text("target_id").notNull(),
    siteName: text("site_name").notNull(),
    weight: integer("weight").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_affinity_company_idx").on(table.companyId),
    scopeTargetIdx: index("myrmidon_fleet_affinity_scope_target_idx").on(table.scope, table.targetId),
  }),
);

export const fleetAffinity = myrmidonFleetAffinity;
