// myrmidon(DBC-4): tests for the datastore-care service.
//
// The service is where the acceptance criteria of DBC-4 live, so they are
// asserted against an in-memory store and fake collectors:
//   * the list endpoint reports the size the probe measured (the acceptance
//     number), the snapshots of the last 24 hours and the settings in force;
//   * a report is built from a live collection, stored with its snapshot id,
//     and exported as markdown under the documented filename;
//   * an unknown target is refused instead of creating an empty series.
//
// Neutral data only: example.com, 192.0.2.0/24.

import { describe, expect, it } from "vitest";

import type { DatastoreSnapshotPayload } from "./domain.js";
import { readDatastoreCareSettings } from "./settings.js";
import {
  createDatastoreCareService,
  UnknownDatastoreError,
  auditReportFilename,
  type DatastoreCareServiceDeps,
  type DatastoreTargetProbe,
} from "./service.js";
import type {
  DatastoreAuditReportInsert,
  DatastoreAuditReportRecord,
  DatastoreCareStore,
  DatastoreSnapshotInsert,
  DatastoreSnapshotRecord,
} from "./store.js";

const NOW = new Date("2026-10-08T05:00:00.000Z");

/** A payload with the fields the service reads; the deep shape is tested in
 *  audit-report.myrmidon.test.ts and collectors/postgres.myrmidon.test.ts. */
function samplePayload(overrides: Partial<DatastoreSnapshotPayload> = {}): DatastoreSnapshotPayload {
  return {
    key: "board",
    engine: "postgres",
    connectionRef: "board-primary",
    database: "board",
    dbId: 16384,
    serverVersion: "PostgreSQL 18.0 on x86_64-pc-linux-gnu",
    capturedAt: NOW.toISOString(),
    databaseBytes: 1_073_741_824,
    tablesBytes: 671_088_640,
    toastBytes: 50_000_000,
    indexBytes: 121_088_640,
    tables: [
      {
        table: "issues",
        totalBytes: 536_870_912,
        heapBytes: 400_000_000,
        toastBytes: 50_000_000,
        indexBytes: 86_870_912,
        liveRows: 1200,
        deadRows: 12,
      },
    ],
    indexes: [{ index: "issues_company_idx", table: "issues", bytes: 10_485_760, scans: 4200 }],
    indexCount: 1,
    invalidIndexCount: 0,
    topQueries: [
      {
        queryId: "1234567",
        calls: 42,
        totalMs: 9000.5,
        meanMs: 214.286,
        rows: 9000,
        query: "SELECT * FROM issues WHERE company_id = $1",
      },
    ],
    topQueriesTotalMs: 12_000,
    statStatementsAvailable: true,
    settings: [
      { name: "jit", value: "off", unit: null },
      { name: "work_mem", value: "4096", unit: null },
    ],
    extensions: [{ name: "pg_stat_statements", version: "1.11" }],
    databaseStats: {
      blksHit: 990_000,
      blksRead: 1000,
      xactCommit: 500,
      xactRollback: 1,
      backends: 7,
      maxConnections: 100,
      tempBytes: 2048,
    },
    backup: {
      available: true,
      dir: "/srv/backups/board",
      fileCount: 1,
      latestFile: "board-2026-10-08.dump",
      latestAt: "2026-10-08T02:00:00.000Z",
      ageHours: 3,
      bytes: 4096,
      note: null,
    },
    optional: { pgvector: null, fullTextSearch: null },
    warnings: [],
    ...overrides,
  };
}

function memoryStore() {
  let seq = 0;
  const nextId = (prefix: string) =>
    `${prefix}-1111-2222-3333-${String(++seq).padStart(12, "0")}`;
  const snapshots: DatastoreSnapshotRecord[] = [];
  const reports: DatastoreAuditReportRecord[] = [];

  const store: DatastoreCareStore = {
    async insertSnapshot(input: DatastoreSnapshotInsert) {
      const record: DatastoreSnapshotRecord = {
        id: nextId("aaaaaaaa"),
        datastoreKey: input.datastoreKey,
        capturedAt: input.capturedAt.toISOString(),
        sizeBytes: input.sizeBytes,
        toastBytes: input.toastBytes,
        indexBytes: input.indexBytes,
        serverVersion: input.serverVersion,
        payload: input.payload,
        createdAt: input.capturedAt.toISOString(),
      };
      snapshots.push(record);
      return record;
    },
    async listSnapshots(datastoreKey, limit) {
      return snapshots
        .filter((record) => record.datastoreKey === datastoreKey)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .slice(0, limit);
    },
    async latestSnapshot(datastoreKey) {
      const list = snapshots
        .filter((record) => record.datastoreKey === datastoreKey)
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
      return list[list.length - 1] ?? null;
    },
    async countSnapshotsSince(datastoreKey, since) {
      return snapshots.filter(
        (record) =>
          record.datastoreKey === datastoreKey && new Date(record.capturedAt).getTime() >= since.getTime(),
      ).length;
    },
    async insertAuditReport(input: DatastoreAuditReportInsert) {
      const record: DatastoreAuditReportRecord = {
        id: nextId("bbbbbbbb"),
        datastoreKey: input.datastoreKey,
        generatedAt: input.generatedAt.toISOString(),
        trigger: input.trigger,
        snapshotId: input.snapshotId,
        criteria: input.criteria,
        topQueries: input.topQueries,
        markdown: input.markdown,
        summary: input.summary,
        createdAt: input.generatedAt.toISOString(),
      };
      reports.push(record);
      return record;
    },
    async listAuditReports(datastoreKey, limit) {
      return reports
        .filter((record) => record.datastoreKey === datastoreKey)
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
        .slice(0, limit);
    },
    async getAuditReport(id) {
      return reports.find((record) => record.id === id) ?? null;
    },
    async pruneSnapshotsBefore(cutoff) {
      const kept = snapshots.filter((record) => new Date(record.capturedAt) >= cutoff);
      const removed = snapshots.length - kept.length;
      snapshots.length = 0;
      snapshots.push(...kept);
      return removed;
    },
    async pruneAuditReportsBefore(cutoff) {
      const kept = reports.filter((record) => new Date(record.generatedAt) >= cutoff);
      const removed = reports.length - kept.length;
      reports.length = 0;
      reports.push(...kept);
      return removed;
    },
  };

  return { store, snapshots, reports };
}

const PROBE: DatastoreTargetProbe = {
  database: "board",
  dbId: 16384,
  serverVersion: "PostgreSQL 18.0 on x86_64-pc-linux-gnu",
  databaseBytes: 1_073_741_824,
};

function deps(store: DatastoreCareStore, overrides: Partial<DatastoreCareServiceDeps> = {}) {
  return {
    store,
    collect: async (_target, now: Date) => samplePayload({ capturedAt: now.toISOString() }),
    probe: async () => PROBE,
    now: () => NOW,
    settings: readDatastoreCareSettings({} as NodeJS.ProcessEnv),
    ...overrides,
  } satisfies DatastoreCareServiceDeps;
}

describe("myrmidon(DBC-4) datastore-care service", () => {
  it("lists the implicit board target with the size the probe just measured", async () => {
    const { store, snapshots } = memoryStore();
    // One snapshot 2 hours old and one 30 hours old: only the first counts.
    await store.insertSnapshot({
      datastoreKey: "board",
      capturedAt: new Date(NOW.getTime() - 2 * 3_600_000),
      sizeBytes: 1_000_000_000,
      toastBytes: 50_000_000,
      indexBytes: 120_000_000,
      serverVersion: PROBE.serverVersion,
      payload: samplePayload(),
    });
    await store.insertSnapshot({
      datastoreKey: "board",
      capturedAt: new Date(NOW.getTime() - 30 * 3_600_000),
      sizeBytes: 900_000_000,
      toastBytes: 40_000_000,
      indexBytes: 100_000_000,
      serverVersion: PROBE.serverVersion,
      payload: samplePayload(),
    });

    const service = createDatastoreCareService(deps(store));
    const answer = await service.readTargets();

    expect(answer.targets).toHaveLength(1);
    const board = answer.targets[0]!;
    expect(board.key).toBe("board");
    expect(board.engine).toBe("postgres");
    expect(board.implicit).toBe(true);
    expect(board.database).toBe("board");
    expect(board.dbId).toBe(16384);
    expect(board.sizeBytes).toBe(1_073_741_824);
    expect(board.sizePretty).toBe("1.0 GiB");
    expect(board.snapshots24h).toBe(1);
    expect(board.lastSnapshot).toMatchObject({ sizeBytes: 1_000_000_000, toastBytes: 50_000_000 });
    expect(board.lastAuditReport).toBeNull();
    expect(board.retentionDays).toBe(90);
    expect(board.intervalSec).toBe(3600);
    expect(board.backup).toEqual(
      expect.objectContaining({ available: true, ageHours: 3 }),
    );
    expect(snapshots).toHaveLength(2);

    expect(answer.settings).toMatchObject({
      enabled: true,
      intervalSec: 3600,
      retentionDays: 90,
      topQueries: 25,
      optionalMetrics: true,
    });
    expect(answer.settings.backupDir).toBeTruthy();
  });

  it("captures a snapshot from a live collection and keeps the series growing", async () => {
    const { store } = memoryStore();
    let collected = 0;
    const service = createDatastoreCareService(
      deps(store, {
        collect: async (_target, now: Date) => {
          collected += 1;
          return samplePayload({ capturedAt: now.toISOString(), databaseBytes: 1_200_000_000 });
        },
      }),
    );

    const first = await service.captureSnapshot("board");
    const second = await service.captureSnapshot("BOARD");
    expect(collected).toBe(2);
    expect(first.snapshot.sizeBytes).toBe(1_200_000_000);
    expect(second.target.key).toBe("board");

    const listed = await service.listSnapshots("board", 10);
    expect(listed).toHaveLength(2);
  });

  it("creates an audit report from a live collection and links it to its snapshot", async () => {
    const { store, snapshots } = memoryStore();
    const service = createDatastoreCareService(deps(store));

    const result = await service.createAuditReport("board", "manual");

    expect(result.report.trigger).toBe("manual");
    expect(result.report.snapshotId).toBe(result.snapshotId);
    expect(result.snapshotId).toBe(snapshots[0]!.id);
    expect(result.report.generatedAt).toBe(NOW.toISOString());
    expect(result.report.criteria.length).toBeGreaterThanOrEqual(17);
    expect(result.report.topQueries).toHaveLength(1);
    expect(result.report.markdown).toContain("# Аудит базы доски — цель `board`");
    expect(result.report.markdown).toContain("SELECT * FROM issues WHERE company_id = $1");
    expect(result.summary.worst).toBe("warn");
    // The collection behind the report is stored, so the hourly series has no gap.
    expect(snapshots).toHaveLength(1);

    const exported = await service.exportAuditMarkdown(result.report.id);
    expect(exported).not.toBeNull();
    expect(exported!.filename).toBe(
      auditReportFilename("board", NOW.toISOString()),
    );
    expect(exported!.filename).toContain("board-db-audit-2026-10-08T05-00-00-000Z.md");
    expect(exported!.markdown).toBe(result.report.markdown);

    const listed = await service.listAuditReports("board", 5);
    expect(listed.map((record) => record.id)).toEqual([result.report.id]);

    const byId = await service.readAuditReport(result.report.id);
    expect(byId?.id).toBe(result.report.id);
  });

  it("feeds the growth criterion from the previous snapshot", async () => {
    const { store } = memoryStore();
    const service = createDatastoreCareService(deps(store));

    await service.captureSnapshot("board");
    const later = createDatastoreCareService(
      deps(store, {
        now: () => new Date(NOW.getTime() + 3_600_000),
        collect: async (_target, now: Date) =>
          samplePayload({
            capturedAt: now.toISOString(),
            databaseBytes: 1_100_000_000,
          }),
      }),
    );
    const result = await later.createAuditReport("board", "hourly");

    const growth = result.report.criteria.find((entry) => entry.id === "growth-24h");
    expect(growth?.verdict).toBe("warn");
    expect(growth?.value).toContain("+"); // a measured growth, not "no previous snapshot"
    expect(growth?.value).not.toContain("нет предыдущего снимка");
  });

  it("refuses an unknown target instead of creating an empty series", async () => {
    const { store, snapshots, reports } = memoryStore();
    const service = createDatastoreCareService(deps(store));

    await expect(service.captureSnapshot("clickhouse")).rejects.toBeInstanceOf(UnknownDatastoreError);
    await expect(service.createAuditReport("clickhouse", "manual")).rejects.toThrow(
      "unknown datastore target: clickhouse",
    );
    await expect(service.listSnapshots("clickhouse")).rejects.toBeInstanceOf(UnknownDatastoreError);
    await expect(service.listAuditReports("other")).rejects.toBeInstanceOf(UnknownDatastoreError);
    expect(snapshots).toHaveLength(0);
    expect(reports).toHaveLength(0);
    expect(await service.exportAuditMarkdown("does-not-exist")).toBeNull();
  });

  it("reports the settings in force, and stays callable when the module is switched off", async () => {
    const { store } = memoryStore();
    const service = createDatastoreCareService(
      deps(store, { settings: readDatastoreCareSettings({ MYRMIDON_DATASTORE_CARE_ENABLED: "0" } as NodeJS.ProcessEnv) }),
    );
    const answer = await service.readTargets();
    expect(answer.settings.enabled).toBe(false);
    // Reads still work: the kill switch stops the collection, not the inspection.
    expect(answer.targets).toHaveLength(1);
  });

  it("takes the backup freshness from the last snapshot, not from the probe", async () => {
    const { store } = memoryStore();
    await store.insertSnapshot({
      datastoreKey: "board",
      capturedAt: new Date(NOW.getTime() - 3_600_000),
      sizeBytes: 1_000_000_000,
      toastBytes: 1,
      indexBytes: 1,
      serverVersion: PROBE.serverVersion,
      payload: samplePayload({
        backup: {
          available: true,
          dir: "/srv/backups/board",
          fileCount: 1,
          latestFile: "board-2026-10-07.dump",
          latestAt: "2026-10-07T02:00:00.000Z",
          ageHours: 27,
          bytes: 4096,
          note: null,
        },
        warnings: ["backup directory /srv/backups/board is unreadable"],
      }),
    });

    const service = createDatastoreCareService(deps(store));
    const board = (await service.readTargets()).targets[0]!;
    expect(board.backup).toEqual({
      available: true,
      latestAt: "2026-10-07T02:00:00.000Z",
      ageHours: 27,
    });
    expect(board.warnings).toEqual(["backup directory /srv/backups/board is unreadable"]);
  });
});