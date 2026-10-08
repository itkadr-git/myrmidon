// server/src/myrmidon/datastore-care/service.ts
//
// myrmidon(DBC-4): the service the routes and the hourly job talk to.
//
// Three operations, in the order an operator meets them:
//   * readTargets()      — what datastores exist and how big they are right now
//                          (the `board` target's size comes from
//                          `pg_database_size`, so it matches a manual psql check
//                          to the byte);
//   * captureSnapshot()  — one collected metric set, stored for 90 days;
//   * createAuditReport()— a snapshot plus the section-6 criteria with their
//                          values, exported as markdown by the button.

import {
  findDatastoreTarget,
  implicitDatastoreTargets,
  prettyBytes,
  type DatastoreSnapshotPayload,
  type DatastoreTarget,
} from "./domain.js";
import {
  buildAuditReportMarkdown,
  evaluateCriteria,
  summarizeCriteria,
  type AuditSummary,
} from "./audit-report.js";
import {
  MAX_LIST_LIMIT,
  type DatastoreAuditReportRecord,
  type DatastoreCareStore,
  type DatastoreSnapshotRecord,
} from "./store.js";
import type { DatastoreCareSettings } from "./settings.js";

/** Live numbers of a target, read with one cheap query. */
export interface DatastoreTargetProbe {
  database: string;
  dbId: number | null;
  serverVersion: string;
  databaseBytes: number;
}

/** What the list endpoint returns for one target. */
export interface DatastoreTargetStatus {
  key: string;
  engine: DatastoreTarget["engine"];
  title: string;
  implicit: boolean;
  connectionRef: string;
  dbId: number | null;
  database: string;
  serverVersion: string;
  /** pg_database_size(current_database()) — the acceptance number. */
  sizeBytes: number;
  sizePretty: string;
  lastSnapshot: {
    id: string;
    capturedAt: string;
    sizeBytes: number;
    toastBytes: number;
    indexBytes: number;
  } | null;
  /** Snapshots collected in the last 24 hours (the project asks for 24/day). */
  snapshots24h: number;
  lastAuditReport: {
    id: string;
    generatedAt: string;
    trigger: string;
    worst: string;
  } | null;
  retentionDays: number;
  intervalSec: number;
  backup: { available: boolean; latestAt: string | null; ageHours: number | null };
  warnings: string[];
}

/** The list endpoint's answer. */
export interface DatastoreTargetsResponse {
  targets: DatastoreTargetStatus[];
  settings: {
    enabled: boolean;
    intervalSec: number;
    retentionDays: number;
    topQueries: number;
    backupDir: string;
    optionalMetrics: boolean;
    warnings: string[];
  };
}

/** What creating a report returns. */
export interface DatastoreAuditReportResult {
  report: DatastoreAuditReportRecord;
  summary: AuditSummary;
  snapshotId: string | null;
}

/** Everything the service needs from the outside world. */
export interface DatastoreCareServiceDeps {
  store: DatastoreCareStore;
  /** Full collection of a target (heavy: sizes, TOAST, indexes, top queries). */
  collect: (target: DatastoreTarget, now: Date) => Promise<DatastoreSnapshotPayload>;
  /** Cheap live probe used by the list endpoint. */
  probe: (target: DatastoreTarget) => Promise<DatastoreTargetProbe>;
  now: () => Date;
  settings: DatastoreCareSettings;
}

/** The service surface. */
export interface DatastoreCareService {
  readTargets(): Promise<DatastoreTargetsResponse>;
  captureSnapshot(
    key: string,
  ): Promise<{ snapshot: DatastoreSnapshotRecord; target: DatastoreTarget }>;
  listSnapshots(datastoreKey: string, limit?: number): Promise<DatastoreSnapshotRecord[]>;
  createAuditReport(key: string, trigger: string): Promise<DatastoreAuditReportResult>;
  listAuditReports(datastoreKey: string, limit?: number): Promise<DatastoreAuditReportRecord[]>;
  readAuditReport(id: string): Promise<DatastoreAuditReportRecord | null>;
  exportAuditMarkdown(
    id: string,
  ): Promise<{ filename: string; markdown: string; report: DatastoreAuditReportRecord } | null>;
}

/** Error thrown for a datastore key the module does not know. */
export class UnknownDatastoreError extends Error {
  readonly datastoreKey: string;

  constructor(key: string) {
    super(`unknown datastore target: ${key}`);
    this.name = "UnknownDatastoreError";
    this.datastoreKey = key;
  }
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(Math.floor(limit), MAX_LIST_LIMIT);
}

/** Filename of the markdown export of a report. */
export function auditReportFilename(key: string, generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, "-");
  return `${key}-db-audit-${stamp}.md`;
}

/** The service implementation. */
export function createDatastoreCareService(deps: DatastoreCareServiceDeps): DatastoreCareService {
  const { store, settings } = deps;

  function requireTarget(key: string): DatastoreTarget {
    const target = findDatastoreTarget(key);
    if (!target) throw new UnknownDatastoreError(key);
    return target;
  }

  return {
    async readTargets(): Promise<DatastoreTargetsResponse> {
      const now = deps.now();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const targets: DatastoreTargetStatus[] = [];

      for (const target of implicitDatastoreTargets()) {
        const probe = await deps.probe(target);
        const lastSnapshot = await store.latestSnapshot(target.key);
        const snapshots24h = await store.countSnapshotsSince(target.key, dayAgo);
        const [lastReport] = await store.listAuditReports(target.key, 1);
        const payload = lastSnapshot?.payload ?? null;

        targets.push({
          key: target.key,
          engine: target.engine,
          title: target.title,
          implicit: target.implicit,
          connectionRef: payload?.connectionRef ?? target.connectionRef,
          dbId: probe.dbId,
          database: probe.database,
          serverVersion: probe.serverVersion,
          sizeBytes: probe.databaseBytes,
          sizePretty: prettyBytes(probe.databaseBytes),
          lastSnapshot: lastSnapshot
            ? {
                id: lastSnapshot.id,
                capturedAt: lastSnapshot.capturedAt,
                sizeBytes: lastSnapshot.sizeBytes,
                toastBytes: lastSnapshot.toastBytes,
                indexBytes: lastSnapshot.indexBytes,
              }
            : null,
          snapshots24h,
          lastAuditReport: lastReport
            ? {
                id: lastReport.id,
                generatedAt: lastReport.generatedAt,
                trigger: lastReport.trigger,
                worst: lastReport.summary?.worst ?? "unknown",
              }
            : null,
          retentionDays: settings.retentionDays,
          intervalSec: settings.intervalSec,
          backup: {
            available: payload?.backup.available ?? false,
            latestAt: payload?.backup.latestAt ?? null,
            ageHours: payload?.backup.ageHours ?? null,
          },
          warnings: payload?.warnings ?? [],
        });
      }

      return {
        targets,
        settings: {
          enabled: settings.enabled,
          intervalSec: settings.intervalSec,
          retentionDays: settings.retentionDays,
          topQueries: settings.topQueries,
          backupDir: settings.backupDir,
          optionalMetrics: settings.optionalMetrics,
          warnings: settings.warnings,
        },
      };
    },

    async captureSnapshot(key: string) {
      const target = requireTarget(key);
      const now = deps.now();
      const payload = await deps.collect(target, now);
      const snapshot = await store.insertSnapshot({
        datastoreKey: target.key,
        capturedAt: now,
        sizeBytes: payload.databaseBytes,
        toastBytes: payload.toastBytes,
        indexBytes: payload.indexBytes,
        serverVersion: payload.serverVersion,
        payload,
      });
      return { snapshot, target };
    },

    async listSnapshots(datastoreKey: string, limit?: number) {
      requireTarget(datastoreKey);
      return store.listSnapshots(datastoreKey, normalizeLimit(limit, 24));
    },

    async createAuditReport(key: string, trigger: string): Promise<DatastoreAuditReportResult> {
      const target = requireTarget(key);
      const now = deps.now();

      // The report is computed from a live collection, and that collection is
      // stored as a snapshot as well: the report then has a snapshot id, and the
      // hourly series of the target stays unbroken.
      const payload = await deps.collect(target, now);
      const previousRecord = await store.latestSnapshot(target.key);
      const snapshot = await store.insertSnapshot({
        datastoreKey: target.key,
        capturedAt: now,
        sizeBytes: payload.databaseBytes,
        toastBytes: payload.toastBytes,
        indexBytes: payload.indexBytes,
        serverVersion: payload.serverVersion,
        payload,
      });

      const criteria = evaluateCriteria(payload, previousRecord?.payload ?? null);
      const summary = summarizeCriteria(criteria, payload);
      const markdown = buildAuditReportMarkdown({
        target,
        generatedAt: now.toISOString(),
        trigger,
        snapshotId: snapshot.id,
        payload,
        criteria,
        summary,
      });

      const report = await store.insertAuditReport({
        datastoreKey: target.key,
        generatedAt: now,
        trigger,
        snapshotId: snapshot.id,
        criteria,
        topQueries: payload.topQueries,
        markdown,
        summary,
      });

      return { report, summary, snapshotId: snapshot.id };
    },

    async listAuditReports(datastoreKey: string, limit?: number) {
      requireTarget(datastoreKey);
      return store.listAuditReports(datastoreKey, normalizeLimit(limit, 24));
    },

    async readAuditReport(id: string) {
      return store.getAuditReport(id);
    },

    async exportAuditMarkdown(id: string) {
      const report = await store.getAuditReport(id);
      if (!report) return null;
      return {
        filename: auditReportFilename(report.datastoreKey, report.generatedAt),
        markdown: report.markdown,
        report,
      };
    },
  };
}