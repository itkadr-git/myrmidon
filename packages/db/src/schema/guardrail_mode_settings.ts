import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Persistent per-rule guardrail mode overrides. */
export const guardrailModeSettings = pgTable(
  "guardrail_mode_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    level: text("level").notNull(),
    targetId: text("target_id").notNull(),
    rule: text("rule").notNull(),
    mode: text("mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("guardrail_mode_settings_lookup_idx").on(table.companyId, table.level, table.targetId),
    ruleUq: uniqueIndex("guardrail_mode_settings_rule_uq").on(
      table.companyId,
      table.level,
      table.targetId,
      table.rule,
    ),
  }),
);
