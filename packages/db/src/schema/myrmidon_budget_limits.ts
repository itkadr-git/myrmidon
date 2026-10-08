// packages/db/src/schema/myrmidon_budget_limits.ts
//
// myrmidon(1.7-BUDGET-CONFIG A): spend limits per hierarchy level — nest
// (company/project), caste (role), foraging pass, issue — plus the change
// journal and the instance-level "signal only" flag default state.
//
// Three tables, all additive (no vendor table is touched):
//  - budget_limits: one row per (company, level, ref). `amount_cents` is the
//    ceiling for the period; `period` is `calendar_month_utc` or `lifetime`
//    (the same windows the vendor budget policies use); `mode` is `hard`
//    (refuse) or `soft` (pause + card to the owner: extend by $N or stop).
//    One limit per (company, level, ref): a save of the same triple replaces
//    the row (PUT semantics).
//  - budget_limit_changes: the journal — who, when, what. One row per create/
//    update/delete, carrying the full before/after of the changed fields.
//  - The global "signal only" flag does NOT live here: it is
//    `instance_settings.general.budgetLimits` (the same JSON-column pattern
//    WIP-LIMIT and STT use), so it is runtime-mutable without a migration.
//
// Rollback restores the image, not the database: an older image ignores all
// three tables, which is why they are additive only.

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** The hierarchy levels a limit can sit on. */
export type BudgetLimitLevel = "nest" | "caste" | "foraging" | "issue";

/** The period a limit is counted over. */
export type BudgetLimitPeriod = "calendar_month_utc" | "lifetime";

/** What happens when the limit is reached. */
export type BudgetLimitMode = "hard" | "soft";

export const budgetLimits = pgTable(
  "budget_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    level: text("level").$type<BudgetLimitLevel>().notNull(),
    /** Level reference: nest → project id or the literal `company`; caste → role key; foraging → `foraging`; issue → issue id. */
    ref: text("ref").notNull(),
    amountCents: integer("amount_cents").notNull(),
    period: text("period").$type<BudgetLimitPeriod>().notNull().default("calendar_month_utc"),
    mode: text("mode").$type<BudgetLimitMode>().notNull().default("hard"),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLevelRefUq: uniqueIndex("budget_limits_company_level_ref_uq").on(
      table.companyId,
      table.level,
      table.ref,
    ),
    companyLevelIdx: index("budget_limits_company_level_idx").on(table.companyId, table.level),
  }),
);

export const budgetLimitChanges = pgTable(
  "budget_limit_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    limitId: uuid("limit_id")
      // set null keeps the journal (the history) alive when the limit row is
      // deleted; the delete journal entry itself carries the full snapshot,
      // so nothing is lost. Company deletion still cascades via company_id.
      .references(() => budgetLimits.id, { onDelete: "set null" }),
    /** create | update | delete */
    action: text("action").notNull(),
    level: text("level").notNull(),
    ref: text("ref").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLimitIdx: index("budget_limit_changes_company_limit_idx").on(
      table.companyId,
      table.limitId,
    ),
    companyAtIdx: index("budget_limit_changes_company_at_idx").on(table.companyId, table.changedAt),
  }),
);
