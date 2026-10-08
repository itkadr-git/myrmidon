// server/src/myrmidon/datastore-care/store.ts
//
// myrmidon(DBC-4): persistence of snapshots and audit reports.
//
// The module never touches vendor tables: it owns `datastore_snapshots` and
// `datastore_audit_reports` (packages/db/src/schema/datastore_care.ts) and
// keeps its own 90-day retention. The store is expressed as an interface so the
// service and the hourly job can be tested without a database.

import { and, desc, eq, gte, lt } from "drizzle-orm";

import { datastoreAuditReports, datastoreSnapshots, type Db } from "@paperclipai/db";

import type { AuditCriterion, AuditSummary } from "./audit-report.js";
import type { DatastoreSnapshotPayload, DatastoreTopQueryMetric } from "./domain.js";

/** One snapshot as the API and the report read it. */
export interface DatastoreSnapshotRecord {
  id: string;
  datastoreKey: string;
  capturedAt: string;
  sizeBytes: number;
  toastBytes: number;
  indexBytes: number;
  serverVersion: string;
  payload: DatastoreSnapshotPayload;
  createdAt: string;
}

/** One audit report as the API and the export read it. */
export interface DatastoreAuditReportRecord {
  id: string;
  datastoreKey: string;
  generatedAt: string;
  trigger: string;
  snapshotId: string | null;
  criteria: AuditCriterion[];
  topQueries: DatastoreTopQueryMetric[];
  markdown: string;
  summary: AuditSummary;
  createdAt: string;
}

/** What the service writes for one snapshot. */
export interface DatastoreSnapshotInsert {
  datastoreKey: string;
  capturedAt: Date;
  sizeBytes: number;
  toastBytes: number;
  indexBytes: number;
  serverVersion: string;
  payload: DatastoreSnapshotPayload;
}

/** What the service writes for one audit report. */
export interface DatastoreAuditReportInsert {
  datastoreKey: string;
  generatedAt: Date;
  trigger: string;
  snapshotId: string | null;
  criteria: AuditCriterion[];
  topQueries: DatastoreTopQueryMetric[];
  markdown: string;
  summary: AuditSummary;
}

/** The persistence surface of the module. */
export interface DatastoreCareStore {
  insertSnapshot(input: DatastoreSnapshotInsert): Promise<DatastoreSnapshotRecord>;
  listSnapshots(datastoreKey: string, limit: number): Promise<DatastoreSnapshotRecord[]>;
  latestSnapshot(datastoreKey: string): Promise<DatastoreSnapshotRecord | null>;
  countSnapshotsSince(datastoreKey: string, since: Date): Promise<number>;
  insertAuditReport(input: DatastoreAuditReportInsert): Promise<DatastoreAuditReportRecord>;
  listAuditReports(datastoreKey: string, limit: number): Promise<DatastoreAuditReportRecord[]>;
  getAuditReport(id: string): Promise<DatastoreAuditReportRecord | null>;
  /** Retention: removes snapshots older than the cutoff, returns how many. */
  pruneSnapshotsBefore(cutoff: Date): Promise<number>;
  /** Retention: removes audit reports older than the cutoff, returns how many. */
  pruneAuditReportsBefore(cutoff: Date): Promise<number>;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapSnapshot(row: typeof datastoreSnapshots.$inferSelect): DatastoreSnapshotRecord {
  return {
    id: row.id,
    datastoreKey: row.datastoreKey,
    capturedAt: toIso(row.capturedAt),
    sizeBytes: Number(row.sizeBytes),
    toastBytes: Number(row.toastBytes),
    indexBytes: Number(row.indexBytes),
    serverVersion: row.serverVersion,
    payload: row.payload as unknown as DatastoreSnapshotPayload,
    createdAt: toIso(row.createdAt),
  };
}

function mapAuditReport(
  row: typeof datastoreAuditReports.$inferSelect,
): DatastoreAuditReportRecord {
  return {
    id: row.id,
    datastoreKey: row.datastoreKey,
    generatedAt: toIso(row.generatedAt),
    trigger: row.trigger,
    snapshotId: row.snapshotId ?? null,
    criteria: row.criteria as unknown as AuditCriterion[],
    topQueries: row.topQueries as unknown as DatastoreTopQueryMetric[],
    markdown: row.markdown,
    summary: row.summary as unknown as AuditSummary,
    createdAt: toIso(row.createdAt),
  };
}

/** The drizzle-backed store of the module. */
export function createDatastoreCareStore(db: Db): DatastoreCareStore {
  return {
    async insertSnapshot(input: DatastoreSnapshotInsert): Promise<DatastoreSnapshotRecord> {
      const [row] = await db
        .insert(datastoreSnapshots)
        .values({
          datastoreKey: input.datastoreKey,
          capturedAt: input.capturedAt,
          sizeBytes: input.sizeBytes,
          toastBytes: input.toastBytes,
          indexBytes: input.indexBytes,
          serverVersion: input.serverVersion,
          payload: input.payload as unknown as Record<string, unknown>,
        })
        .returning();
      if (!row) throw new Error("datastore snapshot insert returned no row");
      return mapSnapshot(row);
    },

    async listSnapshots(datastoreKey: string, limit: number): Promise<DatastoreSnapshotRecord[]> {
      const rows = await db
        .select()
        .from(datastoreSnapshots)
        .where(eq(datastoreSnapshots.datastoreKey, datastoreKey))
        .orderBy(desc(datastoreSnapshots.capturedAt))
        .limit(limit);
      return rows.map(mapSnapshot);
    },

    async latestSnapshot(datastoreKey: string): Promise<DatastoreSnapshotRecord | null> {
      const rows = await db
        .select()
        .from(datastoreSnapshots)
        .where(eq(datastoreSnapshots.datastoreKey, datastoreKey))
        .orderBy(desc(datastoreSnapshots.capturedAt))
        .limit(1);
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async countSnapshotsSince(datastoreKey: string, since: Date): Promise<number> {
      const rows = await db
        .select({ id: datastoreSnapshots.id })
        .from(datastoreSnapshots)
        .where(
          and(eq(datastoreSnapshots.datastoreKey, datastoreKey), gte(datastoreSnapshots.capturedAt, since)),
        );
      return rows.length;
    },

    async insertAuditReport(
      input: DatastoreAuditReportInsert,
    ): Promise<DatastoreAuditReportRecord> {
      const [row] = await db
        .insert(datastoreAuditReports)
        .values({
          datastoreKey: input.datastoreKey,
          generatedAt: input.generatedAt,
          trigger: input.trigger,
          snapshotId: input.snapshotId,
          criteria: input.criteria as unknown as Record<string, unknown>[],
          topQueries: input.topQueries as unknown as Record<string, unknown>[],
          markdown: input.markdown,
          summary: input.summary as unknown as Record<string, unknown>,
        })
        .returning();
      if (!row) throw new Error("datastore audit report insert returned no row");
      return mapAuditReport(row);
    },

    async listAuditReports(datastoreKey: string, limit: number): Promise<DatastoreAuditReportRecord[]> {
      const rows = await db
        .select()
        .from(datastoreAuditReports)
        .where(eq(datastoreAuditReports.datastoreKey, datastoreKey))
        .orderBy(desc(datastoreAuditReports.generatedAt))
        .limit(limit);
      return rows.map(mapAuditReport);
    },

    async getAuditReport(id: string): Promise<DatastoreAuditReportRecord | null> {
      const rows = await db
        .select()
        .from(datastoreAuditReports)
        .where(eq(datastoreAuditReports.id, id))
        .limit(1);
      return rows[0] ? mapAuditReport(rows[0]) : null;
    },

    async pruneSnapshotsBefore(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(datastoreSnapshots)
        .where(lt(datastoreSnapshots.capturedAt, cutoff))
        .returning({ id: datastoreSnapshots.id });
      return rows.length;
    },

    async pruneAuditReportsBefore(cutoff: Date): Promise<number> {
      const rows = await db
        .delete(datastoreAuditReports)
        .where(lt(datastoreAuditReports.generatedAt, cutoff))
        .returning({ id: datastoreAuditReports.id });
      return rows.length;
    },
  };
}

/** Hard cap of rows a listing endpoint returns in one call. */
export const MAX_LIST_LIMIT = 500;