import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// myrmidon(1.6.6 QUOTA-V2): per-project token quota — the daily/weekly token
// limits of one project plus the running usage counters. One row per project
// (company scoped); a null limit means that window is unlimited. `updatedAt`
// and the usage counters are maintained by the quota service; the counters
// let the status API answer without re-aggregating cost events on every read.
export const projectTokenQuotas = pgTable(
  "project_token_quotas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    // null = no daily limit
    dailyTokenLimit: bigint("daily_token_limit", { mode: "number" }),
    // null = no weekly limit
    weeklyTokenLimit: bigint("weekly_token_limit", { mode: "number" }),
    // usage counters (tokens since window start; reset by the service when the window rolls)
    dailyTokensUsed: bigint("daily_tokens_used", { mode: "number" }).notNull().default(0),
    weeklyTokensUsed: bigint("weekly_tokens_used", { mode: "number" }).notNull().default(0),
    dailyWindowStart: timestamp("daily_window_start", { withTimezone: true }).notNull().defaultNow(),
    weeklyWindowStart: timestamp("weekly_window_start", { withTimezone: true }).notNull().defaultNow(),
    setByUserId: text("set_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectUniqueIdx: uniqueIndex("project_token_quotas_project_unique_idx").on(
      table.projectId,
    ),
    companyIdx: index("project_token_quotas_company_idx").on(table.companyId),
  }),
);
