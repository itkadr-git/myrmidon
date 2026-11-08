// server/src/myrmidon/billing-webhook/service.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093): the ingest half of the
// payment webhook skeleton. The service does exactly one thing — store the
// event in `billing_events` — and decides between two outcomes:
//
//   received — the event type is one of the known payment types
//              (invoice.paid / invoice.failed);
//   ignored  — any other type: still stored (the provider log must not lose
//              events) and still answered 200.
//
// The signature check is a STUB (ticket: "подпись пока заглушка"). It never
// rejects a request; before real business logic consumes these rows, a real
// signature verification has to gate this endpoint. There is no activity-log
// write on purpose: the table itself is the audit trail of the skeleton.

import type { Db } from "@myrmidon/db";
import { billingEvents, type NewBillingEventRow } from "@myrmidon/db";

export const BILLING_WEBHOOK_KNOWN_TYPES = ["invoice.paid", "invoice.failed"] as const;
export type BillingWebhookKnownType = (typeof BILLING_WEBHOOK_KNOWN_TYPES)[number];

export interface BillingWebhookInput {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface BillingWebhookResult {
  /** Always true for a well-formed request — unknown types are ignored, not rejected. */
  accepted: true;
  /** "received" for a known type, "ignored" for anything else. */
  stored: "received" | "ignored";
  eventType: string;
}

export interface BillingWebhookServiceDeps {
  /** Resolves the single company of this instance (the audit-precedence rule). */
  listCompanyIds(): Promise<string[]>;
  insertEvent(row: NewBillingEventRow): Promise<void>;
}

export function billingWebhookService(db: Db, deps: Partial<BillingWebhookServiceDeps> = {}) {
  const listCompanyIds = deps.listCompanyIds ?? (async () => dbCompanyIds(db));
  const insertEvent = deps.insertEvent ?? (async (row: NewBillingEventRow) => {
    await db.insert(billingEvents).values(row);
  });

  return {
    /** Stores one webhook event; returns how it was stored. */
    async ingest(input: BillingWebhookInput): Promise<BillingWebhookResult> {
      const known = (BILLING_WEBHOOK_KNOWN_TYPES as readonly string[]).includes(input.eventType);
      const companyId = await resolveSingleCompanyId(listCompanyIds);
      await insertEvent({
        companyId,
        eventType: input.eventType,
        status: known ? "received" : "ignored",
        payload: input.payload,
        signatureStatus: "stub",
      });
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
