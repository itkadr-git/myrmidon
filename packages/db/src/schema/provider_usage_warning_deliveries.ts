import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Durable, idempotent delivery state for provider usage owner warnings. */
export const providerUsageWarningDeliveries = pgTable("provider_usage_warning_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  ownerIssueId: uuid("owner_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  warningKey: text("warning_key").notNull(),
  body: text("body").notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  warningUq: uniqueIndex("provider_usage_warning_deliveries_warning_uq").on(table.companyId, table.warningKey),
  pendingIdx: index("provider_usage_warning_deliveries_pending_idx").on(table.nextAttemptAt, table.deliveredAt),
}));