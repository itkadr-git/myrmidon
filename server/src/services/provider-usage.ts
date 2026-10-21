import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceSettings, providerUsageEventReceipts, providerUsageSnapshots, providerUsageWarningDeliveries, issueComments } from "@paperclipai/db";
import { invalidateAttentionFeedCache } from "./attention.js";
import { issueService } from "./issues.js";
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

  async function ingest(companyId: string, event: ProviderUsageReportedEventV1, now = new Date()): Promise<ProviderUsageIngestResult> {
    const thresholdPercent = await thresholdForCompany(companyId);
    const warning = evaluateProviderUsageWarning(event, thresholdPercent, companyId, now.toISOString());
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
        sourceEventId: event.eventId, ownerIssueId: event.ownerIssueId ?? null,
        used: event.window.used, limits: event.window.limit,
      }).onConflictDoUpdate({
        target: [providerUsageSnapshots.companyId, providerUsageSnapshots.provider,
          providerUsageSnapshots.credentialRef, providerUsageSnapshots.windowKind,
          providerUsageSnapshots.windowStartedAt],
        set: { resetsAt, observedAt, used: event.window.used, limits: event.window.limit,
          sourceEventId: event.eventId, ownerIssueId: event.ownerIssueId ?? null, updatedAt: new Date() },
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
      if (snapshot?.ownerIssueId && warning) {
        const body = `Provider usage warning: ${warning.provider} ${warning.metric} usage reached ${warning.thresholdPercent}% before reset at ${warning.resetsAt}.`;
        await tx.insert(providerUsageWarningDeliveries).values({
          companyId, ownerIssueId: snapshot.ownerIssueId, warningKey: warning.key, body,
        }).onConflictDoNothing();
      }
      invalidateAttentionFeedCache(db, companyId);
      return { accepted: true, duplicate: false, aggregate: snapshot ? aggregateProviderUsageReports([{ schemaVersion: 1, companyId, eventId: snapshot.sourceEventId, provider: snapshot.provider, credentialRef: snapshot.credentialRef, observedAt: snapshot.observedAt.toISOString(), window: { kind: snapshot.windowKind as ProviderUsageReportedEventV1["window"]["kind"], startedAt: snapshot.windowStartedAt.toISOString(), resetsAt: snapshot.resetsAt.toISOString(), used: snapshot.used, limit: snapshot.limits } }], thresholdPercent, now.toISOString())[0] ?? null : null, warning };
    });
  }

  async function list(companyId: string, now = new Date()): Promise<ProviderUsageAggregate[]> {
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
    })), thresholdPercent, now.toISOString()).map((aggregate: ProviderUsageAggregate, index: number) => ({ ...aggregate, ownerIssueId: rows[index]?.ownerIssueId ?? undefined }));
  }

  async function deliverPendingWarnings(now = new Date()): Promise<{ delivered: number; failed: number }> {
    const snapshots = await db.select().from(providerUsageSnapshots).where(and(
      sql`${providerUsageSnapshots.resetsAt} > ${now}`,
      sql`${providerUsageSnapshots.ownerIssueId} is not null`,
    ));
    for (const snapshot of snapshots) {
      const warning = evaluateProviderUsageWarning({
        schemaVersion: 1, companyId: snapshot.companyId, eventId: snapshot.sourceEventId,
        provider: snapshot.provider, credentialRef: snapshot.credentialRef,
        ownerIssueId: snapshot.ownerIssueId ?? undefined,
        observedAt: snapshot.observedAt.toISOString(),
        window: { kind: snapshot.windowKind as ProviderUsageReportedEventV1["window"]["kind"], startedAt: snapshot.windowStartedAt.toISOString(), resetsAt: snapshot.resetsAt.toISOString(), used: snapshot.used, limit: snapshot.limits },
      }, await thresholdForCompany(snapshot.companyId), snapshot.companyId, now.toISOString());
      if (!warning || !snapshot.ownerIssueId) continue;
      const body = `Provider usage warning: ${warning.provider} ${warning.metric} usage reached ${warning.thresholdPercent}% before reset at ${warning.resetsAt}.`;
      await db.insert(providerUsageWarningDeliveries).values({
        companyId: snapshot.companyId, ownerIssueId: snapshot.ownerIssueId, warningKey: warning.key, body,
      }).onConflictDoNothing();
    }
    const pending = await db.select().from(providerUsageWarningDeliveries).where(and(
      sql`${providerUsageWarningDeliveries.deliveredAt} is null`,
      sql`${providerUsageWarningDeliveries.nextAttemptAt} <= ${now}`,
    ));
    let delivered = 0;
    let failed = 0;
    for (const delivery of pending) {
      try {
        const existing = await db.select({ id: issueComments.id }).from(issueComments).where(and(
          eq(issueComments.issueId, delivery.ownerIssueId!), eq(issueComments.body, delivery.body),
        )).limit(1);
        if (existing.length === 0) await issueService(db).addComment(delivery.ownerIssueId!, delivery.body, { runId: null }, { authorType: "system" });
        await db.update(providerUsageWarningDeliveries).set({ deliveredAt: now, updatedAt: now, lastError: null }).where(eq(providerUsageWarningDeliveries.id, delivery.id));
        delivered++;
      } catch (error) {
        await db.update(providerUsageWarningDeliveries).set({ nextAttemptAt: new Date(now.getTime() + 60_000), lastError: error instanceof Error ? error.message : String(error), updatedAt: now }).where(eq(providerUsageWarningDeliveries.id, delivery.id));
        failed++;
      }
    }
    return { delivered, failed };
  }

  return { ingest, list, thresholdForCompany, deliverPendingWarnings };
}
