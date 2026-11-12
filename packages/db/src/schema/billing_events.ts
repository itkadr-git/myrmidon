// packages/db/src/schema/billing_events.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093): append-only log of
// payment-provider webhook events. The webhook handler writes every accepted
// event here before any future business logic consumes it — the skeleton
// stores, it does not act (no invoice state is derived yet).
//
// myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630): the HMAC-SHA256 signature is
// verified by the route before ingest; verified rows carry signature_status
// "verified".
//
// myrmidon(1.7 PAYWALL-WEBHOOK-DEDUP, OPE-12678): body_sha256 is the SHA-256
// of the exact signed request bytes. The partial unique index on
// (company_id, body_sha256) — only where body_sha256 is not null — maps a
// redelivered body to the existing row instead of a second one; rows written
// before this column (body_sha256 NULL) are exempt from the index and are
// left untouched.
//
// Contract (ticket OPE-12093 + OPE-12678):
// - POST /api/billing/webhook accepts invoice.paid / invoice.failed;
// - unknown event types are stored with status "ignored" and answered 200;
// - a repeat delivery of an already stored body is answered 200 with
//   stored "duplicate" and writes no second row.

import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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
    // SHA-256 hex of the exact raw request bytes (1.7 PAYWALL-WEBHOOK-DEDUP,
    // OPE-12678). Nullable: rows stored before this column keep NULL and stay
    // exempt from the dedup index.
    bodySha256: text("body_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("billing_events_company_idx").on(table.companyId),
    typeIdx: index("billing_events_type_idx").on(table.eventType),
    // Dedup of redelivered bodies: one row per (company, body hash). Partial
    // on body_sha256 IS NOT NULL so pre-dedup rows (NULL hash) never conflict
    // and are never rewritten.
    bodySha256Uq: uniqueIndex("billing_events_company_body_sha256_uq")
      .on(table.companyId, table.bodySha256)
      .where(sql`${table.bodySha256} is not null`),
  }),
);

export type BillingEventRow = typeof billingEvents.$inferSelect;
export type NewBillingEventRow = typeof billingEvents.$inferInsert;
