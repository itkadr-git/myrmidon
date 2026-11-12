import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): the raw ingest ledger for arbitrary
 * inbound webhooks.
 *
 * Every accepted webhook body is stored verbatim (rawPayload) as a
 * draft-candidate row: nothing here routes into execution — routing is the
 * next slice. Delivery dedup is enforced by the database across restarts:
 * (companyId, source, externalEventId) is unique, so a provider retry with the
 * same event id can never create a second draft.
 *
 * rawPayload is jsonb, not text: Postgres validates the JSON on insert, and
 * the routing slice needs queries into the body. The original signature
 * header/value are kept alongside for audit and later re-verification.
 */
export const webhookIntakeDrafts = pgTable(
  "webhook_intake_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Caller-declared source id (e.g. "github", "stripe", "zabbix"); free-form, lowercase-trimmed. */
    source: text("source").notNull(),
    /** Provider event/delivery id; dedup partner of source. */
    externalEventId: text("external_event_id").notNull(),
    /** "draft" until a later slice routes it; kept explicit so the transition is a data change. */
    status: text("status").$type<"draft">().notNull().default("draft"),
    eventType: text("event_type"),
    /** The raw body exactly as received (jsonb so Postgres validates it is JSON). */
    rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
    /** Signature scheme used at intake time (e.g. "hmac_sha256"); informational. */
    signatureScheme: text("signature_scheme"),
    /** Signature header name, e.g. "x-hub-signature-256"; never the secret. */
    signatureHeader: text("signature_header"),
    /** Signature value as received; a public header value, not a credential. */
    signatureValue: text("signature_value"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** How many times this (source, event id) arrived, including the first. */
    deliveryAttempts: integer("delivery_attempts").notNull().default(1),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("webhook_intake_drafts_company_source_event_uq").on(
      table.companyId,
      table.source,
      table.externalEventId,
    ),
    index("webhook_intake_drafts_company_received_idx").on(table.companyId, table.receivedAt),
    index("webhook_intake_drafts_company_status_idx").on(table.companyId, table.status, table.receivedAt),
  ],
);
