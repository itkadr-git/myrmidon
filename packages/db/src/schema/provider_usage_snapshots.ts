import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Latest provider-reported usage snapshots. Reports contain opaque credential references only. */
export const providerUsageSnapshots = pgTable(
  "provider_usage_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    credentialRef: text("credential_ref").notNull(),
    windowKind: text("window_kind").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    used: jsonb("used").$type<{ requests?: number; tokens?: number }>().notNull(),
    limits: jsonb("limits").$type<{ requests?: number; tokens?: number }>().notNull(),
    sourceEventId: text("source_event_id").notNull(),
    ownerIssueId: uuid("owner_issue_id").references(() => issues.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    windowUq: uniqueIndex("provider_usage_snapshots_window_uq").on(
      table.companyId,
      table.provider,
      table.credentialRef,
      table.windowKind,
      table.windowStartedAt,
    ),
    companyObservedIdx: index("provider_usage_snapshots_company_observed_idx").on(
      table.companyId,
      table.observedAt,
    ),
  }),
);

/** Receipt ledger provides idempotency when adapters replay a report event. */
export const providerUsageEventReceipts = pgTable(
  "provider_usage_event_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventUq: uniqueIndex("provider_usage_event_receipts_company_event_uq").on(table.companyId, table.eventId),
  }),
);
