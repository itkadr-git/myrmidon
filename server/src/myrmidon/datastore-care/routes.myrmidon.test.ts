// myrmidon(DBC-4): routes tests — supertest against the real router with a
// fake service (no database: the contract here is the HTTP shape, the
// authorization, the kill switch and the markdown export).
//
// Two of these assertions are the acceptance criteria of DBC-4 seen from the
// outside: GET /api/myrmidon/datastores answers the target `board` with the
// size the probe measured, and the export route returns a markdown file whose
// name and body the operator can open.
//
// Neutral data only: example.com, 192.0.2.0/24.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../middleware/index.js";
import { DATASTORE_CARE_ENABLED_ENV } from "./settings.js";
import { datastoreCareRoutes } from "./routes.js";
import { UnknownDatastoreError } from "./service.js";
import type { DatastoreCareService, DatastoreTargetStatus } from "./service.js";
import type {
  DatastoreAuditReportRecord,
  DatastoreSnapshotRecord,
} from "./store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";

const boardMember = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
/** The guard of this module: instance administrator (operator review 08.10). */
const instanceAdmin = {
  type: "board",
  source: "session",
  userId: "user-admin",
  isInstanceAdmin: true,
  companyIds: [COMPANY_ID],
};
/** A signed-in board user without any company membership. */
const noCompanyActor = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [],
};
/** No session at all — the actor middleware answers `type: "none"`. */
const noSessionActor = { type: "none" };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

const MARKDOWN = "# Аудит базы доски — цель `board` (DBC-4, автоотчёт)\n\nSELECT 1;";

function targetStatus(overrides: Partial<DatastoreTargetStatus> = {}): DatastoreTargetStatus {
  return {
    key: "board",
    engine: "postgres",
    title: "База доски",
    implicit: true,
    connectionRef: "board-primary",
    dbId: 16384,
    database: "board",
    serverVersion: "PostgreSQL 18.0",
    sizeBytes: 1_073_741_824,
    sizePretty: "1.0 GiB",
    lastSnapshot: null,
    snapshots24h: 24,
    lastAuditReport: null,
    retentionDays: 90,
    intervalSec: 3600,
    backup: { available: true, latestAt: "2026-10-08T02:00:00.000Z", ageHours: 3 },
    warnings: [],
    ...overrides,
  };
}

function snapshotRecord(): DatastoreSnapshotRecord {
  return {
    id: SNAPSHOT_ID,
    datastoreKey: "board",
    capturedAt: "2026-10-08T05:00:00.000Z",
    sizeBytes: 1_073_741_824,
    toastBytes: 50_000_000,
    indexBytes: 121_088_640,
    serverVersion: "PostgreSQL 18.0",
    payload: null as never,
    createdAt: "2026-10-08T05:00:00.000Z",
  };
}

function reportRecord(): DatastoreAuditReportRecord {
  return {
    id: REPORT_ID,
    datastoreKey: "board",
    generatedAt: "2026-10-08T05:00:00.000Z",
    trigger: "manual",
    snapshotId: SNAPSHOT_ID,
    criteria: [],
    topQueries: [],
    markdown: MARKDOWN,
    summary: {
      ok: 16,
      warn: 1,
      fail: 0,
      unknown: 0,
      worst: "warn",
      databaseBytes: 1_073_741_824,
      databasePretty: "1.0 GiB",
      topQueries: 1,
      statStatementsAvailable: true,
    },
    createdAt: "2026-10-08T05:00:00.000Z",
  };
}

function fakeService(overrides: Partial<DatastoreCareService> = {}) {
  const service = {
    readTargets: vi.fn(async () => ({
      targets: [targetStatus()],
      settings: {
        enabled: true,
        intervalSec: 3600,
        retentionDays: 90,
        topQueries: 25,
        backupDir: "/srv/backups/board",
        optionalMetrics: true,
        warnings: [],
      },
    })),
    captureSnapshot: vi.fn(async () => ({ snapshot: snapshotRecord(), target: { key: "board" } })),
    listSnapshots: vi.fn(async () => [snapshotRecord()]),
    createAuditReport: vi.fn(async () => ({
      report: reportRecord(),
      summary: reportRecord().summary,
      snapshotId: SNAPSHOT_ID,
    })),
    listAuditReports: vi.fn(async () => [reportRecord()]),
    readAuditReport: vi.fn(async () => reportRecord()),
    exportAuditMarkdown: vi.fn(async () => ({
      filename: "board-db-audit-2026-10-08T05-00-00-000Z.md",
      markdown: MARKDOWN,
      report: reportRecord(),
    })),
    ...overrides,
  } as unknown as DatastoreCareService & { [key: string]: ReturnType<typeof vi.fn> };
  return service;
}

function app(
  actor: unknown,
  options: { enabled?: boolean; service?: DatastoreCareService } = {},
) {
  const service = options.service ?? fakeService();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    datastoreCareRoutes({
      service,
      env: { [DATASTORE_CARE_ENABLED_ENV]: options.enabled === false ? "0" : "1" },
    }),
  );
  server.use(errorHandler);
  return { server, service: service as unknown as { [key: string]: ReturnType<typeof vi.fn> } };
}

describe("myrmidon(DBC-4) datastore-care routes", () => {
  it("answers the board target with the size the probe measured", async () => {
    const { server, service } = app(instanceAdmin);

    const response = await request(server).get("/api/myrmidon/datastores");

    expect(response.status).toBe(200);
    expect(response.body.targets).toHaveLength(1);
    expect(response.body.targets[0]).toMatchObject({
      key: "board",
      engine: "postgres",
      implicit: true,
      sizeBytes: 1_073_741_824,
      sizePretty: "1.0 GiB",
      snapshots24h: 24,
      retentionDays: 90,
    });
    expect(response.body.settings).toMatchObject({ enabled: true, intervalSec: 3600, retentionDays: 90 });
    expect(service.readTargets).toHaveBeenCalledTimes(1);
  });

  it("refuses every route to an agent, to a board member and to a session without access", async () => {
    // `assertInstanceAdmin` (server/src/routes/authz.ts) is the guard: the module
    // reports instance-level measurements (database size, catalog contents,
    // server parameters), so a plain board member of a company has nothing to
    // read here (operator review 08.10, item 2).
    for (const actor of [agentActor, noSessionActor, noCompanyActor, boardMember]) {
      const { server } = app(actor);
      const listed = await request(server).get("/api/myrmidon/datastores");
      expect([401, 403]).toContain(listed.status);

      const created = await request(server).post("/api/myrmidon/datastores/board/audit-reports");
      expect([401, 403]).toContain(created.status);
    }
  });

  it("serves the snapshots of a target and the report list without the markdown body", async () => {
    const { server } = app(instanceAdmin);

    const snapshots = await request(server).get("/api/myrmidon/datastores/board/snapshots?limit=5");
    expect(snapshots.status).toBe(200);
    expect(snapshots.body.snapshots[0]).toMatchObject({ id: SNAPSHOT_ID, sizeBytes: 1_073_741_824 });

    const reports = await request(server).get("/api/myrmidon/datastores/board/audit-reports");
    expect(reports.status).toBe(200);
    expect(reports.body.reports[0]).toMatchObject({ id: REPORT_ID, trigger: "manual" });
    expect(reports.body.reports[0].markdown).toBeUndefined();
  });

  it("creates a report on demand and points at its export", async () => {
    const { server, service } = app(instanceAdmin);

    const response = await request(server).post("/api/myrmidon/datastores/board/audit-reports");

    expect(response.status).toBe(200);
    expect(response.body.report).toMatchObject({ id: REPORT_ID, trigger: "manual" });
    expect(response.body.report.markdown).toBeUndefined();
    expect(response.body.summary.worst).toBe("warn");
    expect(response.body.snapshotId).toBe(SNAPSHOT_ID);
    expect(response.body.exportUrl).toBe(`/api/myrmidon/audit-reports/${REPORT_ID}/export`);
    expect(service.createAuditReport).toHaveBeenCalledWith("board", "manual");
  });

  it("exports the report as a markdown attachment", async () => {
    const { server } = app(instanceAdmin);

    const response = await request(server).get(`/api/myrmidon/audit-reports/${REPORT_ID}/export`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.headers["content-disposition"]).toContain(
      'attachment; filename="board-db-audit-2026-10-08T05-00-00-000Z.md"',
    );
    expect(response.text).toContain("Аудит базы доски");
    expect(response.text).toContain("SELECT 1;");
  });

  it("answers 404 for an unknown target and an unknown report", async () => {
    // `assertInstanceAdmin` guards the routes, so the 404 path is only reachable
    // past the guard — the actor must be the instance admin here.
    const { server } = app(
      instanceAdmin,
      {
        service: fakeService({
          listSnapshots: async () => {
            throw new UnknownDatastoreError("clickhouse");
          },
          exportAuditMarkdown: async () => null,
        }),
      },
    );

    const unknownTarget = await request(server).get("/api/myrmidon/datastores/clickhouse/snapshots");
    expect(unknownTarget.status).toBe(404);
    expect(unknownTarget.body.error).toBe("unknown_datastore");

    const unknownReport = await request(server).get(
      "/api/myrmidon/audit-reports/55555555-5555-4555-8555-555555555555/export",
    );
    expect(unknownReport.status).toBe(404);
    expect(unknownReport.body.error).toBe("unknown_audit_report");
  });

  it("stays readable and refuses writes while the module is switched off", async () => {
    const { server, service } = app(instanceAdmin, { enabled: false });

    const listed = await request(server).get("/api/myrmidon/datastores");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ enabled: false, targets: [], settings: null });
    expect(service.readTargets).not.toHaveBeenCalled();

    const snapshots = await request(server).get("/api/myrmidon/datastores/board/snapshots");
    expect(snapshots.status).toBe(200);
    expect(snapshots.body).toEqual({ enabled: false, snapshots: [] });

    const created = await request(server).post("/api/myrmidon/datastores/board/audit-reports");
    expect(created.status).toBe(409);
    expect(created.body.error).toBe("datastore_care_disabled");
    expect(service.createAuditReport).not.toHaveBeenCalled();

    const exported = await request(server).get(`/api/myrmidon/audit-reports/${REPORT_ID}/export`);
    expect(exported.status).toBe(409);
  });
});