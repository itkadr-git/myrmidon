// myrmidon(1.6.6 PROCS-0.3A): the operator surface, driven end to end through
// express with the seams injected.
//
// What these tests pin — the acceptance points of the ticket: the lane totals
// are visible through the board itself, the p95 summary is a window over the
// journal, the pg_stat_statements report answers correctly when the extension
// is absent (it is part B's job to install it, not this endpoint's), the
// cpu-profile capture is off by default, is admin-only, refuses a second
// concurrent capture, and hands the file over as an attachment — all without
// a restart and without touching the default behaviour of the board.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  API_LOAD_MAX_WINDOW_SEC,
  boardLoadRoutes,
  CPU_PROFILE_ENABLED_ENV,
  type BoardLoadRoutesDeps,
} from "./routes.js";
import { CpuProfileBusyError, type CpuProfileRuntime } from "./cpu-profile.js";
import { createRequestLog, DEFAULT_REQUEST_LOAD_WINDOW_SEC } from "./request-load.js";
import type { PgStatStatementsRead } from "./pg-stat-statements.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const FINISHED_AT = "2026-10-08T12:00:30.000Z";
const PROFILE_JSON = JSON.stringify({ nodes: [], startTime: 1, endTime: 2 });

const DENIED = () => Object.assign(new Error("denied"), { status: 401 });

function fakeRuntime(overrides: Record<string, unknown> = {}): CpuProfileRuntime {
  return {
    capture: async () => ({ json: PROFILE_JSON, finishedAt: FINISHED_AT }),
    status: () => ({
      enabled: true,
      running: false,
      latest: { finishedAt: FINISHED_AT, seconds: 60, bytes: PROFILE_JSON.length },
    }),
    latestJson: () => PROFILE_JSON,
    ...overrides,
  } as unknown as CpuProfileRuntime;
}

function appWith(overrides: Partial<BoardLoadRoutesDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    boardLoadRoutes({
      db: {} as never,
      env: { [CPU_PROFILE_ENABLED_ENV]: "true" },
      now: () => NOW,
      assertRead: () => undefined,
      assertAdmin: () => undefined,
      lanes: () => [{ lane: "http_route", dbQueries: 4, busyMs: 12.5, executions: 2 }],
      requestLog: null,
      cpuProfiles: fakeRuntime(),
      readStatements: async (): Promise<PgStatStatementsRead> => ({ available: true, rows: [] }),
      ...overrides,
    }),
  );
  return app;
}

describe("board load routes", () => {
  it("reports the lane totals through the board itself", async () => {
    const response = await request(appWith()).get("/api/myrmidon/board-load/lanes");

    expect(response.status).toBe(200);
    expect(response.body.collectedAt).toBe(NOW.toISOString());
    expect(response.body.lanes).toEqual([{ lane: "http_route", dbQueries: 4, busyMs: 12.5, executions: 2 }]);
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("gates every read behind the board reader", async () => {
    const app = appWith({ assertRead: DENIED });
    const lanes = await request(app).get("/api/myrmidon/board-load/lanes");
    const apiLoad = await request(app).get("/api/myrmidon/board-load/api-load");
    const status = await request(app).get("/api/myrmidon/board-load/cpu-profile");

    expect([lanes.status, apiLoad.status, status.status]).toEqual([401, 401, 401]);
  });

  it("answers an empty api-load summary when no journal is wired", async () => {
    const response = await request(appWith()).get("/api/myrmidon/board-load/api-load");

    expect(response.status).toBe(200);
    expect(response.body.windowSec).toBe(DEFAULT_REQUEST_LOAD_WINDOW_SEC);
    expect(response.body.journalSize).toBe(0);
    expect(response.body.routes).toEqual([]);
  });

  it("summarises p95 per route over the requested window", async () => {
    const log = createRequestLog({ capacity: 50 });
    for (const [durationMs, status] of [
      [10, 200],
      [30, 200],
      [500, 503],
    ] as const) {
      log.record({ method: "GET", route: "/api/runs", status, durationMs, at: NOW.getTime() });
    }
    log.record({ method: "GET", route: "/api/old", status: 200, durationMs: 1, at: NOW.getTime() - 3_600_000 });

    const response = await request(appWith({ requestLog: log })).get(
      `/api/myrmidon/board-load/api-load?window=900&limit=5`,
    );

    expect(response.status).toBe(200);
    expect(response.body.windowSec).toBe(900);
    expect(response.body.journalSize).toBe(4);
    expect(response.body.routes).toHaveLength(1);
    expect(response.body.routes[0]).toMatchObject({
      method: "GET",
      route: "/api/runs",
      count: 3,
      errorCount: 1,
      p95Ms: 500,
    });
  });

  it("clamps a nonsense window instead of failing the read", async () => {
    const response = await request(appWith()).get("/api/myrmidon/board-load/api-load?window=99999999");

    expect(response.status).toBe(200);
    expect(response.body.windowSec).toBe(API_LOAD_MAX_WINDOW_SEC);
  });

  it("gates the SQL text report and the profiler behind the instance admin", async () => {
    const app = appWith({ assertAdmin: DENIED });
    const statements = await request(app).get("/api/myrmidon/board-load/pg-stat-statements");
    const capture = await request(app).post("/api/myrmidon/board-load/cpu-profile").send({ seconds: 5 });
    const latest = await request(app).get("/api/myrmidon/board-load/cpu-profile/latest");

    expect([statements.status, capture.status, latest.status]).toEqual([401, 401, 401]);
  });

  it("answers the pg_stat_statements report when the extension is missing", async () => {
    const missing = await request(
      appWith({
        readStatements: async (): Promise<PgStatStatementsRead> => ({
          available: false,
          reason: "extension_missing",
          detail: "pg_stat_statements is not installed",
        }),
      }),
    ).get("/api/myrmidon/board-load/pg-stat-statements");

    expect(missing.status).toBe(200);
    expect(missing.body.available).toBe(false);
    expect(missing.body.reason).toBe("extension_missing");
    expect(missing.body.detail).toContain("not installed");
    expect(missing.body.limit).toBe(20);
  });

  it("serves the top statements when the extension is readable", async () => {
    const rows = [{ query: "SELECT 1", calls: 10, totalMs: 100, meanMs: 10, rows: 10 }];
    const response = await request(
      appWith({ readStatements: async (): Promise<PgStatStatementsRead> => ({ available: true, rows }) }),
    ).get("/api/myrmidon/board-load/pg-stat-statements?limit=3");

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    expect(response.body.limit).toBe(3);
    expect(response.body.rows).toEqual(rows);
  });

  it("leaves the profiler off unless the operator asks for it", async () => {
    const status = await request(appWith({ env: {} })).get("/api/myrmidon/board-load/cpu-profile");
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(false);

    const off = await request(appWith({ env: { [CPU_PROFILE_ENABLED_ENV]: "false" } }))
      .post("/api/myrmidon/board-load/cpu-profile")
      .send({});
    expect(off.status).toBe(503);
    expect(off.body.error).toBe("cpu_profile_disabled");
  });

  it("hands the capture over as a download without a restart", async () => {
    const response = await request(appWith())
      .post("/api/myrmidon/board-load/cpu-profile")
      .send({ seconds: 60 });

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="board-cpu-profile-20261008120030.cpuprofile"',
    );
    expect(response.text).toBe(PROFILE_JSON);
  });

  it("refuses a second capture while one is running", async () => {
    const busy = await request(
      appWith({
        cpuProfiles: fakeRuntime({
          capture: async () => {
            throw new CpuProfileBusyError();
          },
        }),
      }),
    )
      .post("/api/myrmidon/board-load/cpu-profile")
      .send({});

    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe("cpu_profile_busy");
  });

  it("answers a failed capture instead of hanging the request", async () => {
    const failed = await request(
      appWith({
        cpuProfiles: fakeRuntime({
          capture: async () => {
            throw new Error("inspector was already in use");
          },
        }),
      }),
    )
      .post("/api/myrmidon/board-load/cpu-profile")
      .send({});

    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("cpu_profile_failed");
    expect(failed.body.detail).toContain("inspector");
  });

  it("downloads the retained capture and says so when there is none", async () => {
    const retained = await request(appWith()).get("/api/myrmidon/board-load/cpu-profile/latest");
    expect(retained.status).toBe(200);
    expect(retained.text).toBe(PROFILE_JSON);

    const none = await request(appWith({ cpuProfiles: fakeRuntime({ latestJson: () => null }) })).get(
      "/api/myrmidon/board-load/cpu-profile/latest",
    );
    expect(none.status).toBe(404);
    expect(none.body.error).toBe("cpu_profile_not_captured");
  });
});