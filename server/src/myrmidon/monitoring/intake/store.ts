// server/src/myrmidon/monitoring/intake/store.ts
// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): persistence for raw webhook drafts.
// The (companyId, source, externalEventId) unique index is the dedup: an
// insert race or provider retry lands here as "existing" and the route answers
// without storing a second draft. `deliveryAttempts` counts retries of the
// same identity.

import { and, eq, sql } from "drizzle-orm";
import { webhookIntakeDrafts, type Db } from "@myrmidon/db";
import type { IntakeDelivery } from "./domain.js";

/** "created" = first delivery of this identity; "existing" = duplicate. */
export type IntakeStoreResult = "created" | "existing";

export interface IntakeDraftRow {
  id: string;
  companyId: string;
  source: string;
  externalEventId: string;
  status: "draft";
  eventType: string | null;
  signatureScheme: string | null;
  signatureHeader: string | null;
  signatureValue: string | null;
  receivedAt: string;
  deliveryAttempts: number;
  lastDeliveryAt: string;
}

export interface WebhookIntakeStore {
  /** Stores the raw payload as a draft; returns "existing" for a repeat event id. */
  insertDraft(
    companyId: string,
    delivery: IntakeDelivery,
    payload: { raw: unknown; signatureScheme?: string | null; signatureHeader?: string | null; signatureValue?: string | null },
  ): Promise<IntakeStoreResult>;
  get(companyId: string, source: string, externalEventId: string): Promise<IntakeDraftRow | null>;
}

type Runner = Pick<Db, "select" | "insert" | "update">;

export function createDbWebhookIntakeStore(db: Runner): WebhookIntakeStore {
  return {
    async insertDraft(companyId, delivery, payload) {
      const rows = await db
        .insert(webhookIntakeDrafts)
        .values({
          companyId,
          source: delivery.source,
          externalEventId: delivery.externalEventId,
          eventType: delivery.eventType,
          rawPayload: payload.raw as never,
          signatureScheme: payload.signatureScheme ?? null,
          signatureHeader: payload.signatureHeader ?? null,
          signatureValue: payload.signatureValue ?? null,
        })
        .onConflictDoUpdate({
          target: [
            webhookIntakeDrafts.companyId,
            webhookIntakeDrafts.source,
            webhookIntakeDrafts.externalEventId,
          ],
          set: {
            deliveryAttempts: sql`${webhookIntakeDrafts.deliveryAttempts} + 1`,
            lastDeliveryAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
        .returning({
          id: webhookIntakeDrafts.id,
          attempts: webhookIntakeDrafts.deliveryAttempts,
        });
      // attempts === 1 only when the insert path won; on conflict the update
      // bumped the counter, so the row came from the duplicate path.
      return rows[0]?.attempts === 1 ? "created" : "existing";
    },
    async get(companyId, source, externalEventId) {
      const rows = await db
        .select()
        .from(webhookIntakeDrafts)
        .where(
          and(
            eq(webhookIntakeDrafts.companyId, companyId),
            eq(webhookIntakeDrafts.source, source),
            eq(webhookIntakeDrafts.externalEventId, externalEventId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        source: row.source,
        externalEventId: row.externalEventId,
        status: row.status,
        eventType: row.eventType,
        signatureScheme: row.signatureScheme,
        signatureHeader: row.signatureHeader,
        signatureValue: row.signatureValue,
        receivedAt: row.receivedAt.toISOString(),
        deliveryAttempts: row.deliveryAttempts,
        lastDeliveryAt: row.lastDeliveryAt.toISOString(),
      };
    },
  };
}
