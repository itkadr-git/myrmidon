import { and, eq, gt, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceSettings, providerUsageEventReceipts, providerUsageSnapshots, providerUsageWarningDeliveries, issueComments } from "@paperclipai/db";
import { invalidateAttentionFeedCache } from "./attention.js";
import { issueService } from "./issues.js";
import {
  aggregateProviderUsageReports,
  describeProviderUsageWarning,
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
  async function thresholdForCompany(companyId: string): Promise<number> {
    const rows = await db.select().from(instanceSettings).limit(1);
    const settings = rows[0]?.general as Record<string, unknown> | undefined;
    return resolveProviderUsageWarningThreshold(settings?.[PROVIDER_USAGE_WARNING_THRESHOLD_SETTING], companyId);
  }

  /**
   * `ownerIssueId` is the already-resolved owner issue uuid (the event may carry a
   * human identifier such as OPE-1); null/undefined means no owner comment.
   */
  async function ingest(companyId: string, event: ProviderUsageReportedEventV1, now = new Date(), ownerIssueId: string | null = null): Promise<ProviderUsageIngestResult> {
    const thresholdPercent = await thresholdForCompany(companyId);
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
        sourceEventId: event.eventId, ownerIssueId,
        used: event.window.used, limits: event.window.limit,
      }).onConflictDoUpdate({
        target: [providerUsageSnapshots.companyId, providerUsageSnapshots.provider,
          providerUsageSnapshots.credentialRef, providerUsageSnapshots.windowKind,
          providerUsageSnapshots.windowStartedAt],
        set: { resetsAt, observedAt, used: event.window.used, limits: event.window.limit,
          sourceEventId: event.eventId,
          ownerIssueId: ownerIssueId ? sql`coalesce(${providerUsageSnapshots.ownerIssueId}, ${ownerIssueId})` : providerUsageSnapshots.ownerIssueId,
          updatedAt: new Date() },
        setWhere: lt(providerUsageSnapshots.observedAt, observedAt),
      });

      const rows = await tx.select().from(providerUsageSnapshots).where(and(
        eq(providerUsageSnapshots.companyId, companyId),
        eq(providerUsageSnapshots.provider, event.provider),
        eq(providerUsageSnapshots.credentialRef, event.credentialRef),
        eq(providerUsageSnapshots.windowKind, event.window.kind),
        eq(providerUsageSnapshots.windowStartedAt, startedAt),
      ));
      const snapshot = rows[0];
      const snapshotEvent: ProviderUsageReportedEventV1 | null = snapshot ? {
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
      } : null;
      const warning = snapshotEvent
        ? evaluateProviderUsageWarning(snapshotEvent, thresholdPercent, companyId, now.toISOString())
        : null;
      if (snapshot?.ownerIssueId && warning) {
        const body = `Provider usage warning: ${describeProviderUsageWarning(warning)}`;
        await tx.insert(providerUsageWarningDeliveries).values({
          companyId, ownerIssueId: snapshot.ownerIssueId, warningKey: warning.key, body, nextAttemptAt: now,
        }).onConflictDoNothing();
      }
      invalidateAttentionFeedCache(db, companyId);
      return { accepted: true, duplicate: false, aggregate: snapshot ? aggregateProviderUsageReports([snapshotEvent!], thresholdPercent, now.toISOString())[0] ?? null : null, warning };
    });
  }

  async function list(companyId: string, now = new Date()): Promise<ProviderUsageAggregate[]> {
    const thresholdPercent = await thresholdForCompany(companyId);
    const rows = await db.select().from(providerUsageSnapshots).where(and(
      eq(providerUsageSnapshots.companyId, companyId),
      gt(providerUsageSnapshots.resetsAt, now),
    ));
    // One snapshot per (credential, window) is enforced by a unique index, so aggregate
    // row by row and carry each row's own owner issue instead of matching by position.
    return rows.flatMap((snapshot) => aggregateProviderUsageReports([{
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
    }], thresholdPercent, now.toISOString()).map((aggregate: ProviderUsageAggregate) => ({
      ...aggregate,
      ownerIssueId: snapshot.ownerIssueId ?? undefined,
    })));
  }

  async function deliverPendingWarnings(now = new Date()): Promise<{ delivered: number; failed: number }> {
    const snapshots = await db.select().from(providerUsageSnapshots).where(and(
      gt(providerUsageSnapshots.resetsAt, now),
      isNotNull(providerUsageSnapshots.ownerIssueId),
    ));
    const thresholds = new Map<string, number>();
    for (const snapshot of snapshots) {
      if (!thresholds.has(snapshot.companyId)) thresholds.set(snapshot.companyId, await thresholdForCompany(snapshot.companyId));
      const warning = evaluateProviderUsageWarning({
        schemaVersion: 1, companyId: snapshot.companyId, eventId: snapshot.sourceEventId,
        provider: snapshot.provider, credentialRef: snapshot.credentialRef,
        ownerIssueId: snapshot.ownerIssueId ?? undefined,
        observedAt: snapshot.observedAt.toISOString(),
        window: { kind: snapshot.windowKind as ProviderUsageReportedEventV1["window"]["kind"], startedAt: snapshot.windowStartedAt.toISOString(), resetsAt: snapshot.resetsAt.toISOString(), used: snapshot.used, limit: snapshot.limits },
      }, thresholds.get(snapshot.companyId)!, snapshot.companyId, now.toISOString());
      if (!warning || !snapshot.ownerIssueId) continue;
      const body = `Provider usage warning: ${describeProviderUsageWarning(warning)}`;
      await db.insert(providerUsageWarningDeliveries).values({
        companyId: snapshot.companyId, ownerIssueId: snapshot.ownerIssueId, warningKey: warning.key, body, nextAttemptAt: now,
      }).onConflictDoNothing();
    }
    const pending = await db.select().from(providerUsageWarningDeliveries).where(and(
      isNull(providerUsageWarningDeliveries.deliveredAt),
      lte(providerUsageWarningDeliveries.nextAttemptAt, now),
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
