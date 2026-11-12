// server/src/myrmidon/billing-webhook/service.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630): the ingest half of the payment
// webhook. The service does exactly one thing — store the verified event in
// `billing_events` — and decides between three outcomes:
//
//   received  — the event type is one of the known payment types
//               (invoice.paid / invoice.failed);
//   ignored   — any other type: still stored (the provider log must not lose
//               events) and still answered 200;
//   duplicate — the exact same signed body was already stored (1.7
//               PAYWALL-WEBHOOK-DEDUP, OPE-12678): nothing is written and the
//               delivery is still answered 200 so the provider does not retry
//               forever.
//
// The signature verification is performed by routes.ts before ingest is called.
// Verified events are stored with signatureStatus "verified". There is no
// activity-log write on purpose: the table itself is the audit trail.

import { createHash } from "node:crypto";
import type { Db } from "@myrmidon/db";
import { billingEvents, type NewBillingEventRow } from "@myrmidon/db";
import { sql } from "drizzle-orm";

export const BILLING_WEBHOOK_KNOWN_TYPES = ["invoice.paid", "invoice.failed"] as const;
export type BillingWebhookKnownType = (typeof BILLING_WEBHOOK_KNOWN_TYPES)[number];

export interface BillingWebhookInput {
  eventType: string;
  payload: Record<string, unknown>;
  signatureStatus?: string;
  /** Raw request body bytes (Buffer or utf-8 string) to hash for dedup. */
  rawBody?: Buffer | string;
  /** Precomputed SHA-256 hex of the raw request bytes. */
  bodySha256?: string;
}

export type BillingWebhookStored = "received" | "ignored" | "duplicate";

export interface BillingWebhookResult {
  /** Always true for a well-formed request — unknown types are ignored, not rejected. */
  accepted: true;
  /** "received" for a known type, "ignored" for anything else, "duplicate" for a redelivered body. */
  stored: BillingWebhookStored;
  eventType: string;
}

export interface BillingWebhookServiceDeps {
  /** Resolves the single company of this instance (the audit-precedence rule). */
  listCompanyIds(): Promise<string[]>;
  /**
   * Inserts one row; returns false when the row was NOT written (the dedup
   * index absorbed a repeat delivery), true when a new row was stored.
   */
  insertEvent(row: NewBillingEventRow): Promise<boolean>;
}

export function computeBodySha256(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function billingWebhookService(db: Db, deps: Partial<BillingWebhookServiceDeps> = {}) {
  const listCompanyIds = deps.listCompanyIds ?? (async () => dbCompanyIds(db));
  // myrmidon(1.7 PAYWALL-WEBHOOK-DEDUP, OPE-12678): ON CONFLICT DO NOTHING
  // against the partial unique index billing_events_company_body_sha256_uq on
  // (company_id, body_sha256) where body_sha256 is not null — a redelivered
  // signed body maps to the existing row instead of a second one. Rows with a
  // NULL body_sha256 (written before this column) never conflict. The `where`
  // config must repeat the index predicate: Postgres matches ON CONFLICT to a
  // partial index only when the arbiter predicate is given (otherwise "no
  // unique or exclusion constraint matching the ON CONFLICT specification",
  // 42P10). drizzle-orm 0.45.x emits `on conflict (cols) where <predicate> do
  // nothing` for `{ target, where }`.
  const insertEvent = deps.insertEvent ?? (async (row: NewBillingEventRow) => {
    const inserted = await db
      .insert(billingEvents)
      .values(row)
      .onConflictDoNothing({
        target: [billingEvents.companyId, billingEvents.bodySha256],
        where: sql`${billingEvents.bodySha256} is not null`,
      })
      .returning({ id: billingEvents.id });
    return inserted.length > 0;
  });

  return {
    /** Stores one webhook event; returns how it was stored. */
    async ingest(input: BillingWebhookInput): Promise<BillingWebhookResult> {
      const known = (BILLING_WEBHOOK_KNOWN_TYPES as readonly string[]).includes(input.eventType);
      const companyId = await resolveSingleCompanyId(listCompanyIds);
      // Dedup key over the exact signed bytes (never the re-serialized body):
      // an earlier row with the same hash absorbs the delivery.
      const bodySha256 =
        input.bodySha256 ??
        (input.rawBody !== undefined ? computeBodySha256(input.rawBody) : undefined);

      const inserted = await insertEvent({
        companyId,
        eventType: input.eventType,
        status: known ? "received" : "ignored",
        payload: input.payload,
        signatureStatus: input.signatureStatus ?? "verified",
        bodySha256: bodySha256 ?? null,
      });
      if (!inserted) {
        // Repeat delivery of an already stored body: answer 200, write nothing.
        return { accepted: true, stored: "duplicate", eventType: input.eventType };
      }
      return { accepted: true, stored: known ? "received" : "ignored", eventType: input.eventType };
    },
  };
}

/** Exactly one company (the vendor-name audit rule) or null — the route answers 503. */
async function resolveSingleCompanyId(listCompanyIds: () => Promise<string[]>): Promise<string> {
  const ids = await listCompanyIds();
  if (ids.length !== 1) {
    const error = new Error(`billing webhook needs exactly one company, found ${ids.length}`) as Error & { code?: string };
    error.code = "company_unresolved";
    throw error;
  }
  return ids[0];
}

async function dbCompanyIds(db: Db): Promise<string[]> {
  const { companies } = await import("@myrmidon/db");
  const rows = await db.select({ id: companies.id }).from(companies);
  return rows.map((row) => row.id);
}
