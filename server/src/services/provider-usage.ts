import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceSettings, providerUsageEventReceipts, providerUsageSnapshots } from "@paperclipai/db";
import { invalidateAttentionFeedCache } from "./attention.js";
import {
  aggregateProviderUsageReports,
  evaluateProviderUsageWarning,
  PROVIDER_USAGE_WARNING_THRESHOLD_SETTING,
  resolveProviderUsageWarningThreshold,
  type ProviderUsageAggregate,
  type ProviderUsageReportedEventV1,
  type ProviderUsageWarning,
} from "@paperclipai/shared";

export interface ProviderUsageIngestResult {
  accepted: boolean;
  duplicate: boolean;
  aggregate: ProviderUsageAggregate | null;
  warning: ProviderUsageWarning | null;
}

type ProviderUsageDb = Db;

export function providerUsageService(db: Db) {
  async function thresholdForCompany(_companyId: string): Promise<number> {
    const rows = await db.select().from(instanceSettings).limit(1);
    const settings = rows[0]?.general as Record<string, unknown> | undefined;
    return resolveProviderUsageWarningThreshold(settings?.[PROVIDER_USAGE_WARNING_THRESHOLD_SETTING]);
  }

  async function ingest(companyId: string, event: ProviderUsageReportedEventV1): Promise<ProviderUsageIngestResult> {
    const thresholdPercent = await thresholdForCompany(companyId);
    const warning = evaluateProviderUsageWarning(event, thresholdPercent, companyId);
    return db.transaction(async (tx) => {
      const receipts = await tx.insert(providerUsageEventReceipts).values({ companyId, eventId: event.eventId })
        .onConflictDoNothing({ target: [providerUsageEventReceipts.companyId, providerUsageEventReceipts.eventId] })
        .returning({ id: providerUsageEventReceipts.id });
      if (receipts.length === 0) return { accepted: false, duplicate: true, aggregate: null, warning: null };

      const startedAt = new Date(event.window.startedAt);
      const observedAt = new Date(event.observedAt);
      const resetsAt = new Date(event.window.resetsAt);
      await tx.insert(providerUsageSnapshots).values({
        companyId, provider: event.provider, credentialRef: event.credentialRef,
        windowKind: event.window.kind, windowStartedAt: startedAt, resetsAt, observedAt,
        used: event.window.used, limits: event.window.limit, sourceEventId: event.eventId,
      }).onConflictDoUpdate({
        target: [providerUsageSnapshots.companyId, providerUsageSnapshots.provider,
          providerUsageSnapshots.credentialRef, providerUsageSnapshots.windowKind,
          providerUsageSnapshots.windowStartedAt],
        set: { resetsAt, observedAt, used: event.window.used, limits: event.window.limit,
          sourceEventId: event.eventId, updatedAt: new Date() },
        setWhere: sql`${providerUsageSnapshots.observedAt} < ${observedAt}`,
      });

      const rows = await tx.select().from(providerUsageSnapshots).where(and(
        eq(providerUsageSnapshots.companyId, companyId),
        eq(providerUsageSnapshots.provider, event.provider),
        eq(providerUsageSnapshots.credentialRef, event.credentialRef),
        eq(providerUsageSnapshots.windowKind, event.window.kind),
        eq(providerUsageSnapshots.windowStartedAt, startedAt),
      ));
      const snapshot = rows[0];
      invalidateAttentionFeedCache(db, companyId);
      return { accepted: true, duplicate: false, aggregate: snapshot ? aggregateProviderUsageReports([{ schemaVersion: 1, companyId, eventId: snapshot.sourceEventId, provider: snapshot.provider, credentialRef: snapshot.credentialRef, observedAt: snapshot.observedAt.toISOString(), window: { kind: snapshot.windowKind as ProviderUsageReportedEventV1["window"]["kind"], startedAt: snapshot.windowStartedAt.toISOString(), resetsAt: snapshot.resetsAt.toISOString(), used: snapshot.used, limit: snapshot.limits } }], thresholdPercent)[0] ?? null : null, warning };
    });
  }

  async function list(companyId: string): Promise<ProviderUsageAggregate[]> {
    const thresholdPercent = await thresholdForCompany(companyId);
    const rows = await db.select().from(providerUsageSnapshots).where(and(
      eq(providerUsageSnapshots.companyId, companyId),
      sql`${providerUsageSnapshots.resetsAt} > now()`,
    ));
    return aggregateProviderUsageReports(rows.map((snapshot) => ({
      schemaVersion: 1,
      companyId,
      eventId: snapshot.sourceEventId,
      provider: snapshot.provider,
      credentialRef: snapshot.credentialRef,
      observedAt: snapshot.observedAt.toISOString(),
      window: {
        kind: snapshot.windowKind as ProviderUsageReportedEventV1["window"]["kind"],
        startedAt: snapshot.windowStartedAt.toISOString(),
        resetsAt: snapshot.resetsAt.toISOString(),
        used: snapshot.used,
        limit: snapshot.limits,
      },
    })), thresholdPercent);
  }

  return { ingest, list, thresholdForCompany };
}
