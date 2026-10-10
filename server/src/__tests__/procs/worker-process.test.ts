// server/src/__tests__/procs/worker-process.test.ts
//
// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the e2e of the
// standalone worker — one api process and one worker process against the one
// test database. Pins:
//   * the worker boots with role `worker`, registers in board_processes with
//     apiPort null, and answers its own loopback `/internal/ready` (ч.F
//     contract) with 200 while the api process answers `/api/health`;
//   * the worker's registry row is readable through the api process — the
//     row is the cross-process write→read proof (written by the worker,
//     served by the api);
//   * SIGTERM drains the worker cleanly (the heartbeat executor quiesces,
//     the probe listener closes) and the api process never notices.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import {
  requestApi,
  startApiProcess,
  stopApiProcess,
  stopApiProcesses,
  pickFreePort,
  WORKER_ENTRY,
  type ApiProcessHandle,
} from "./helpers/api-process-harness.js";

type BoardProcessView = {
  bootId: string;
  role: string;
  pid: number;
  apiPort: number | null;
  status: "live" | "stale";
  self: boolean;
};

type BoardProcessesResponse = {
  selfBootId: string;
  processes: BoardProcessView[];
};

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeProcs = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the worker-process e2e on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeProcs("worker process on one test database (PROCS-1.5 ч.H)", () => {
  let baseDir = "";
  let database: EmbeddedPostgresTestDatabase | null = null;
  let api: ApiProcessHandle | null = null;
  let worker: ApiProcessHandle | null = null;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-procs-worker-"));
    let connectionString = externalTestDatabaseUrl;
    if (!connectionString) {
      database = await startEmbeddedPostgresTestDatabase("paperclip-procs-worker-");
      connectionString = database.connectionString;
    }
    // The api child of the split layout: serves HTTP, owns no timers.
    api = await startApiProcess({
      baseDir,
      index: 0,
      connectionString,
      role: "api",
      port: await pickFreePort(),
    });
    // The worker child: owns the heartbeat executor and the background
    // sweeps, answers its loopback readiness probe on a port of its own —
    // the board listener of the worker child still binds PORT (stage 1), so
    // the probe port must not collide with it.
    worker = await startApiProcess({
      baseDir,
      index: 1,
      connectionString,
      role: "worker",
      entry: WORKER_ENTRY,
      readyPath: "/internal/ready",
      port: await pickFreePort(),
      probePort: await pickFreePort(),
      // The worker boot runs the full startServer startup (migrations check,
      // recovery, sweep arming) before the probe reports ready — give it the
      // same budget the cold-boot api children get.
      readyTimeoutMs: 360_000,
    });
  }, 480_000);

  afterAll(async () => {
    await stopApiProcesses([worker, api].filter((h): h is ApiProcessHandle => h !== null));
    if (database) await database.cleanup();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }, 120_000);

  it("scenario 1: the worker registers as role worker with apiPort null and answers /internal/ready", async () => {
    const ready = await requestApi(worker!.baseUrl, "/internal/ready");
    expect(ready.status, `worker readiness: ${ready.text.slice(0, 400)}`).toBe(200);
    // The ч.F contract body (process-readiness, landed in #1152).
    const body = ready.json as {
      status: string;
      ready: boolean;
      role: string;
      checks: Array<{ id: string; status: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.ready).toBe(true);
    expect(body.role).toBe("worker");
    expect(body.checks.every((check) => check.status !== "not_ready")).toBe(true);
    expect(body.checks.map((check) => check.id).sort()).toEqual(["bus", "database", "migrations"]);

    // The worker's row, read through the api process — the cross-process
    // write→read proof of the shared database.
    const registry = await requestApi(api!.baseUrl, "/api/myrmidon/board-processes");
    expect(registry.status, `registry read: ${registry.text.slice(0, 400)}`).toBe(200);
    const view = registry.json as BoardProcessesResponse;
    const workerRow = view.processes.find((row) => row.role === "worker");
    expect(workerRow, "worker row in board_processes").toBeDefined();
    expect(workerRow?.apiPort).toBeNull();
    expect(workerRow?.status).toBe("live");

    // The api child of the layout is there too, with its own port.
    const apiRow = view.processes.find((row) => row.role === "api");
    expect(apiRow, "api row in board_processes").toBeDefined();
    expect(apiRow?.apiPort).toBe(api!.port);
    } finally {
      console.log("=== API OUTPUT ===\n" + api!.output());
      console.log("=== WORKER OUTPUT ===\n" + worker!.output());
    }
  }, 120_000);

  it("scenario 2: the worker probe serves /healthz for the container runtime", async () => {
    const healthz = await requestApi(worker!.baseUrl, "/healthz");
    expect(healthz.status, `worker healthz: ${healthz.text.slice(0, 400)}`).toBe(200);
    const body = healthz.json as { role?: string; status?: string; scope?: string };
    expect(body.role).toBe("worker");
    expect(body.status).toBe("ok");
    // Without a ч.B supervisor the aggregate degrades to the process's own checks.
    expect(body.scope).toBe("process");
  }, 60_000);

  it("scenario 3: SIGTERM drains the worker while the api keeps serving", async () => {
    const stopPromise = stopApiProcess(worker!, { signal: "SIGTERM", timeoutMs: 60_000 });
    const duringDrain = await Promise.all(
      Array.from({ length: 4 }, async () => await requestApi(api!.baseUrl, "/api/health")),
    );
    for (const response of duringDrain) {
      expect(response.status).toBe(200);
    }
    const stop = await stopPromise;
    expect(
      stop.drained,
      `worker did not leave within its drain budget:\n${worker!.output()}`,
    ).toBe(true);
    expect(stop.code).toBe(0);

    // The probe port is closed ...
    await expect(requestApi(worker!.baseUrl, "/internal/ready")).rejects.toThrow();
    // ... while the api still serves the shared database.
    const health = await requestApi(api!.baseUrl, "/api/health");
    expect(health.status).toBe(200);
  }, 180_000);
});
