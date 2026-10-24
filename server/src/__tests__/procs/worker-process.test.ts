// server/src/__tests__/procs/worker-process.test.ts
//
// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the e2e of the
// standalone worker — one api process and one worker process against the one
// test database. Pins:
//   * the standalone entry (server/src/worker.ts) boots the board runtime with
//     role `worker`, registers in board_processes with that role, and answers
//     `/internal/ready` (ч.F contract, mounted by the board app) with 200
//     while the api process answers `/api/health`;
//   * the worker's registry row is readable through the api process — the
//     row is the cross-process write→read proof (written by the worker,
//     served by the api);
//   * a double SIGTERM drains the worker once (OPE-9107) and the api never notices;

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
    // The worker child, through the standalone entry: owns the heartbeat
    // executor and the background sweeps. Its boot runs the full startServer
    // startup (migrations, recovery, sweep arming) — give it the cold-boot
    // budget of the api children.
    worker = await startApiProcess({
      baseDir,
      index: 1,
      connectionString,
      role: "worker",
      entry: WORKER_ENTRY,
      port: await pickFreePort(),
      readyTimeoutMs: 360_000,
    });
  }, 480_000);

  afterAll(async () => {
    await stopApiProcesses([worker, api].filter((h): h is ApiProcessHandle => h !== null));
    if (database) await database.cleanup();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }, 120_000);

  it("scenario 1: the worker registers as role worker and answers /internal/ready", async () => {
    // The listener answers before the boot recovery is over; readiness (ч.F)
    // turns 200 only once it is finished.
    let ready = await requestApi(worker!.baseUrl, "/internal/ready");
    for (let attempt = 0; ready.status !== 200 && attempt < 240; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = await requestApi(worker!.baseUrl, "/internal/ready");
    }
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
    expect(workerRow?.status).toBe("live");

    // The api child of the layout is there too, with its own port.
    const apiRow = view.processes.find((row) => row.role === "api");
    expect(apiRow, "api row in board_processes").toBeDefined();
    expect(apiRow?.apiPort).toBe(api!.port);
  }, 240_000);

  it("scenario 2: the worker serves /healthz for the container runtime", async () => {
    const healthz = await requestApi(worker!.baseUrl, "/healthz");
    // 200 or 503 by the supervisor's view of the process; the contract pinned
    // here is that the worker answers the balancer's path with its own role.
    expect([200, 503], `worker healthz: ${healthz.text.slice(0, 400)}`).toContain(healthz.status);
    const body = healthz.json as { role?: string };
    expect(body.role).toBe("worker");
  }, 60_000);

  it("scenario 3: an api process forwards a single route to the worker (OPE-9107)", async () => {
    // Wait until the worker has finished its boot recovery (scenario 1 does the
    // same; repeated here so the scenario stands alone).
    let ready = await requestApi(worker!.baseUrl, "/internal/ready");
    for (let attempt = 0; ready.status !== 200 && attempt < 240; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ready = await requestApi(worker!.baseUrl, "/internal/ready");
    }
    expect(ready.status).toBe(200);
    // A single route is answered by the worker: not the proxy's own 503, and the
    // same status as asking the worker's board app directly.
    const viaApi = await fetch(new URL("/api/companies/c1/attention", api!.baseUrl));
    const direct = await fetch(new URL("/api/companies/c1/attention", worker!.baseUrl));
    expect(viaApi.status, `via api: ${await viaApi.text()}`).not.toBe(503);
    expect(viaApi.status).toBe(direct.status);
    // An ordinary route stays local to the api process.
    expect((await requestApi(api!.baseUrl, "/api/health")).status).toBe(200);
  }, 240_000);

  it("scenario 4: a double SIGTERM drains the worker once, the api answers 503 + Retry-After for single routes (OPE-9107)", async () => {
    const exited = new Promise<void>((resolve) => worker!.child.once("exit", () => resolve()));
    worker!.child.kill("SIGTERM");
    // Signals of one kind coalesce while pending, so the second one goes out a
    // moment later, while the first shutdown is still draining.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stillDraining = worker!.alive();
    if (stillDraining) worker!.child.kill("SIGTERM");
    const duringDrain = await Promise.all(
      Array.from({ length: 4 }, async () => await requestApi(api!.baseUrl, "/api/health")),
    );
    for (const response of duringDrain) {
      expect(response.status).toBe(200);
    }
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`worker did not leave:\n${worker!.output()}`)), 60_000)),
    ]);
    // Clean exit (not killed by the second signal) and one shutdown run: the
    // second signal joined the first.
    expect(worker!.child.signalCode, worker!.output()).toBeNull();
    expect(worker!.child.exitCode, worker!.output()).toBe(0);
    const joined = worker!.output().split("shutdown already in progress; joining it").length - 1;
    // At most one join, and exactly one when the second signal found the first
    // shutdown still running; never a second run of the shutdown.
    expect(joined, worker!.output()).toBeLessThanOrEqual(1);
    if (stillDraining) expect(joined, worker!.output()).toBe(1);
    expect(worker!.output()).not.toMatch(/shutdown failed/);

    // The worker's port is closed ...
    await expect(requestApi(worker!.baseUrl, "/internal/ready")).rejects.toThrow();
    // ... a single route on the api process is a 503 with Retry-After, never a
    // local answer ...
    const single = await fetch(new URL("/api/companies/c1/attention", api!.baseUrl));
    expect(single.status).toBe(503);
    expect(single.headers.get("retry-after")).toBe("2");
    // ... and the api still serves its own routes from the shared database.
    expect((await requestApi(api!.baseUrl, "/api/health")).status).toBe(200);
  }, 180_000);
});
