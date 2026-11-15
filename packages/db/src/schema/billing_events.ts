// packages/db/src/schema/billing_events.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093): append-only log of
// payment-provider webhook events. The webhook handler writes every accepted
// event here before any future business logic consumes it — the skeleton
// stores, it does not act (no invoice state is derived yet).
//
// Contract (ticket OPE-12093):
// - POST /api/billing/webhook accepts invoice.paid / invoice.failed;
// - unknown event types are stored with status "ignored" and answered 200;
// - the signature check is a stub for now (TODO before production).

import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const BILLING_EVENT_STATUSES = ["received", "ignored"] as const;
export type BillingEventStatus = (typeof BILLING_EVENT_STATUSES)[number];

export const BILLING_EVENT_TYPES = ["invoice.paid", "invoice.failed"] as const;
export type BillingEventType = (typeof BILLING_EVENT_TYPES)[number];

export const billingEvents = pgTable(
  "billing_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Raw event type exactly as the provider sent it ("invoice.paid",
    // "invoice.failed", or anything else — unknown types are kept, not dropped).
    eventType: text("event_type").notNull(),
    // received = a known type; ignored = an unknown type (answered 200).
    status: text("status").notNull().default("received"),
    // The parsed provider payload; kept verbatim for later replay/audit.
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    // Signature verification status: "stub" (skeleton default) or "verified"
    // (1.7 PAYWALL-WEBHOOK, OPE-12630: HMAC-SHA256 verified).
    signatureStatus: text("signature_status").notNull().default("stub"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("billing_events_company_idx").on(table.companyId),
    typeIdx: index("billing_events_type_idx").on(table.eventType),
  }),
);

export type BillingEventRow = typeof billingEvents.$inferSelect;
export type NewBillingEventRow = typeof billingEvents.$inferInsert;
