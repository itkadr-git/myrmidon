// server/src/myrmidon/foraging/store.ts
//
// myrmidon(1.6-FORAGE): the database side of FORAGING.
//
// Everything the sweep and the routes need is behind `ForagingStore`, so the
// comparison, the budget stop and the candidate rule are tested without a
// database. Two tables only, both ours (`foraging_sources`, `foraging_findings`);
// no vendor table is written.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { foragingFindings, foragingSources, foragingSpendEvents } from "@paperclipai/db";
import type { ForagingFindingStatus, ForagingSourceKind } from "./domain.js";
// myrmidon(1.6.1-FORAGING-LIMITS-UI)
import type { ForagingSpendOutcome } from "@paperclipai/db";

export interface ForagingSourceRow {
  id: string;
  companyId: string;
  role: string;
  url: string;
  kind: ForagingSourceKind;
  enabled: boolean;
  lastSnapshot: string[] | null;
  lastSnapshotAt: Date | null;
  lastCheckedAt: Date | null;
  lastError: string | null;
}

export interface ForagingSourceInput {
  role: string;
  url: string;
  kind: ForagingSourceKind;
  enabled?: boolean;
}

export interface ForagingFindingRow {
  id: string;
  sourceId: string;
  role: string;
  status: ForagingFindingStatus;
  summary: string;
  diff: { added: string[]; removed: string[] };
  skillKey: string;
  candidateRef: string | null;
  reason: string | null;
  detectedAt: Date;
}

export interface ForagingFindingInsert {
  companyId: string;
  sourceId: string;
  role: string;
  status: ForagingFindingStatus;
  summary: string;
  diff: { added: string[]; removed: string[] };
  skillKey: string;
  candidateRef: string | null;
  reason: string | null;
  detectedAt: Date;
}

export interface ForagingSourcePatch {
  lastSnapshot: string[];
  lastSnapshotAt: Date;
  lastCheckedAt: Date;
  lastError: string | null;
}

export interface ForagingReadPatch {
  lastCheckedAt: Date;
  lastError: string | null;
}

// myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend ledger rows.

export interface ForagingSpendInsert {
  companyId: string;
  sourceId: string;
  role: string;
  agentId: string | null;
  url: string;
  costCents: number;
  outcome: ForagingSpendOutcome;
  occurredAt: Date;
}

export interface ForagingSpendBreakdownRow {
  role: string;
  url: string;
  costCents: number;
  reads: number;
  lastOccurredAt: Date | null;
}

export interface ForagingStore {
  listSources(companyId: string): Promise<ForagingSourceRow[]>;
  enabledSources(companyId: string): Promise<ForagingSourceRow[]>;
  upsertSource(companyId: string, input: ForagingSourceInput): Promise<ForagingSourceRow>;
  deleteSource(companyId: string, sourceId: string): Promise<boolean>;
  saveSnapshot(companyId: string, sourceId: string, patch: ForagingSourcePatch): Promise<void>;
  saveRead(companyId: string, sourceId: string, patch: ForagingReadPatch): Promise<void>;
  insertFinding(input: ForagingFindingInsert): Promise<ForagingFindingRow>;
  listFindings(companyId: string, limit: number): Promise<ForagingFindingRow[]>;
  /** Findings still waiting for a candidate; used when the port comes online. */
  listUnverifiedFindings(companyId: string, limit: number): Promise<ForagingFindingRow[]>;
  markFindingCandidate(
    companyId: string,
    findingId: string,
    status: ForagingFindingStatus,
    candidateRef: string | null,
    reason: string | null,
  ): Promise<void>;
  /** Findings of the current UTC month, for the per-company pass budget. */
  monthFindingCount(companyId: string, since: Date): Promise<number>;
  listCompanyIds(): Promise<string[]>;
  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend ledger the limits read.
  /** One row per source read; the pass writes it right after the read. */
  insertSpendEvent(input: ForagingSpendInsert): Promise<void>;
  /** Spend of a window, per role and per agent (null-key = no agent). */
  spendWindows(
    companyId: string,
    daySince: Date,
    monthSince: Date,
  ): Promise<{
    dayCents: number;
    monthCents: number;
    byRole: Map<string, number>;
    byAgent: Map<string, number>;
  }>;
  /** Spend per role and per source url of a window, for the Costs view. */
  spendBreakdown(companyId: string, since: Date): Promise<ForagingSpendBreakdownRow[]>;
}

function toSource(row: typeof foragingSources.$inferSelect): ForagingSourceRow {
  return {
    id: row.id,
    companyId: row.companyId,
    role: row.role,
    url: row.url,
    kind: row.kind,
    enabled: row.enabled,
    lastSnapshot: row.lastSnapshot ?? null,
    lastSnapshotAt: row.lastSnapshotAt ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    lastError: row.lastError ?? null,
  };
}

function toFinding(row: typeof foragingFindings.$inferSelect): ForagingFindingRow {
  return {
    id: row.id,
    sourceId: row.sourceId,
    role: row.role,
    status: row.status,
    summary: row.summary,
    diff: row.diff,
    skillKey: row.skillKey,
    candidateRef: row.candidateRef ?? null,
    reason: row.reason ?? null,
    detectedAt: row.detectedAt,
  };
}

export function createDbForagingStore(db: Db): ForagingStore {
  return {
    async listSources(companyId) {
      const rows = await db
        .select()
        .from(foragingSources)
        .where(eq(foragingSources.companyId, companyId))
        .orderBy(foragingSources.role, foragingSources.url);
      return rows.map(toSource);
    },

    async enabledSources(companyId) {
      const rows = await db
        .select()
        .from(foragingSources)
        .where(and(eq(foragingSources.companyId, companyId), eq(foragingSources.enabled, true)))
        .orderBy(foragingSources.role, foragingSources.url);
      return rows.map(toSource);
    },

    async upsertSource(companyId, input) {
      await db
        .insert(foragingSources)
        .values({
          companyId,
          role: input.role,
          url: input.url,
          kind: input.kind,
          enabled: input.enabled ?? true,
        })
        .onConflictDoUpdate({
          target: [foragingSources.companyId, foragingSources.role, foragingSources.url],
          set: {
            kind: input.kind,
            enabled: input.enabled ?? true,
            updatedAt: new Date(),
          },
        });
      const row = await db
        .select()
        .from(foragingSources)
        .where(
          and(
            eq(foragingSources.companyId, companyId),
            eq(foragingSources.role, input.role),
            eq(foragingSources.url, input.url),
          ),
        )
        .then((rows) => rows[0]);
      return toSource(row);
    },

    async deleteSource(companyId, sourceId) {
      const deleted = await db
        .delete(foragingSources)
        .where(and(eq(foragingSources.companyId, companyId), eq(foragingSources.id, sourceId)))
        .returning({ id: foragingSources.id });
      return deleted.length > 0;
    },

    async saveSnapshot(companyId, sourceId, patch) {
      await db
        .update(foragingSources)
        .set({
          lastSnapshot: patch.lastSnapshot,
          lastSnapshotAt: patch.lastSnapshotAt,
          lastCheckedAt: patch.lastCheckedAt,
          lastError: patch.lastError,
          updatedAt: new Date(),
        })
        .where(and(eq(foragingSources.companyId, companyId), eq(foragingSources.id, sourceId)));
    },

    async saveRead(companyId, sourceId, patch) {
      await db
        .update(foragingSources)
        .set({
          lastCheckedAt: patch.lastCheckedAt,
          lastError: patch.lastError,
          updatedAt: new Date(),
        })
        .where(and(eq(foragingSources.companyId, companyId), eq(foragingSources.id, sourceId)));
    },

    async insertFinding(input) {
      const row = await db
        .insert(foragingFindings)
        .values(input)
        .returning()
        .then((rows) => rows[0]);
      return toFinding(row);
    },

    async listFindings(companyId, limit) {
      const rows = await db
        .select()
        .from(foragingFindings)
        .where(eq(foragingFindings.companyId, companyId))
        .orderBy(desc(foragingFindings.detectedAt))
        .limit(limit);
      return rows.map(toFinding);
    },

    async listUnverifiedFindings(companyId, limit) {
      const rows = await db
        .select()
        .from(foragingFindings)
        .where(and(eq(foragingFindings.companyId, companyId), eq(foragingFindings.status, "unverified")))
        .orderBy(desc(foragingFindings.detectedAt))
        .limit(limit);
      return rows.map(toFinding);
    },

    async markFindingCandidate(companyId, findingId, status, candidateRef, reason) {
      await db
        .update(foragingFindings)
        .set({ status, candidateRef, reason })
        .where(and(eq(foragingFindings.companyId, companyId), eq(foragingFindings.id, findingId)));
    },

    async monthFindingCount(companyId, since) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(foragingFindings)
        .where(and(eq(foragingFindings.companyId, companyId), sql`${foragingFindings.detectedAt} >= ${since}`));
      return Number(row?.count ?? 0);
    },

    // myrmidon(1.6.1-FORAGING-LIMITS-UI): the spend ledger.

    async insertSpendEvent(input) {
      await db.insert(foragingSpendEvents).values(input);
    },

    async spendWindows(companyId, daySince, monthSince) {
      const [dayRow] = await db
        .select({ cents: sql<number>`coalesce(sum(${foragingSpendEvents.costCents}), 0)::int` })
        .from(foragingSpendEvents)
        .where(and(eq(foragingSpendEvents.companyId, companyId), gte(foragingSpendEvents.occurredAt, daySince)));
      const [monthRow] = await db
        .select({ cents: sql<number>`coalesce(sum(${foragingSpendEvents.costCents}), 0)::int` })
        .from(foragingSpendEvents)
        .where(and(eq(foragingSpendEvents.companyId, companyId), gte(foragingSpendEvents.occurredAt, monthSince)));
      const roleRows = await db
        .select({
          role: foragingSpendEvents.role,
          cents: sql<number>`coalesce(sum(${foragingSpendEvents.costCents}), 0)::int`,
        })
        .from(foragingSpendEvents)
        .where(and(eq(foragingSpendEvents.companyId, companyId), gte(foragingSpendEvents.occurredAt, daySince)))
        .groupBy(foragingSpendEvents.role);
      const agentRows = await db
        .select({
          agentId: foragingSpendEvents.agentId,
          cents: sql<number>`coalesce(sum(${foragingSpendEvents.costCents}), 0)::int`,
        })
        .from(foragingSpendEvents)
        .where(and(eq(foragingSpendEvents.companyId, companyId), gte(foragingSpendEvents.occurredAt, daySince)))
        .groupBy(foragingSpendEvents.agentId);
      const byRole = new Map<string, number>();
      for (const row of roleRows) byRole.set(row.role, Number(row.cents));
      const byAgent = new Map<string, number>();
      for (const row of agentRows) {
        if (row.agentId !== null) byAgent.set(row.agentId, Number(row.cents));
      }
      return {
        dayCents: Number(dayRow?.cents ?? 0),
        monthCents: Number(monthRow?.cents ?? 0),
        byRole,
        byAgent,
      };
    },

    async spendBreakdown(companyId, since) {
      const rows = await db
        .select({
          role: foragingSpendEvents.role,
          url: foragingSpendEvents.url,
          costCents: sql<number>`coalesce(sum(${foragingSpendEvents.costCents}), 0)::int`,
          reads: sql<number>`count(*)::int`,
          lastOccurredAt: sql<Date | null>`max(${foragingSpendEvents.occurredAt})`,
        })
        .from(foragingSpendEvents)
        .where(and(eq(foragingSpendEvents.companyId, companyId), gte(foragingSpendEvents.occurredAt, since)))
        .groupBy(foragingSpendEvents.role, foragingSpendEvents.url)
        .orderBy(desc(sql`coalesce(sum(${foragingSpendEvents.costCents}), 0)`));
      return rows.map((row) => ({
        role: row.role,
        url: row.url,
        costCents: Number(row.costCents),
        reads: Number(row.reads),
        lastOccurredAt: row.lastOccurredAt ? new Date(row.lastOccurredAt) : null,
      }));
    },

    async listCompanyIds() {
      const rows = await db
        .selectDistinct({ companyId: foragingSources.companyId })
        .from(foragingSources);
      return rows.map((row) => row.companyId);
    },
  };
}