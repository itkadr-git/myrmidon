import { pgTable, uuid, text, integer, real, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const myrmidonFleetSites = pgTable(
  "myrmidon_fleet_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    slug: text("slug").notNull(),
    fleetdUrl: text("fleetd_url").notNull(),
    label: text("label").notNull(),
    siteCaFingerprint: text("site_ca_fingerprint"),
    region: text("region"),
    capacityCpu: real("capacity_cpu").notNull(),
    capacityRamGb: real("capacity_ram_gb").notNull(),
    maxBots: integer("max_bots"),
    maxRunTokensMin: integer("max_run_tokens_min"),
    status: text("status").notNull().default("enabled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("myrmidon_fleet_sites_company_idx").on(table.companyId),
    companySlugUq: uniqueIndex("myrmidon_fleet_sites_company_slug_uq").on(table.companyId, table.slug),
  }),
);
