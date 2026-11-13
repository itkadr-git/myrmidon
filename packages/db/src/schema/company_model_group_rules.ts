import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Company-owned model selection rules; runtime consumers are intentionally out of scope. */
export const companyModelGroupRules = pgTable(
  "company_model_group_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    stepClass: text("step_class").notNull(),
    modelGroup: text("model_group").notNull(),
    /** Null is the company default; otherwise this is a caste key in the same company. */
    casteKey: text("caste_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyScopeIdx: index("company_model_group_rules_company_idx").on(table.companyId),
    companyStepCasteUq: uniqueIndex("company_model_group_rules_scope_step_uq").on(
      table.companyId,
      table.casteKey,
      table.stepClass,
    ),
  }),
);
