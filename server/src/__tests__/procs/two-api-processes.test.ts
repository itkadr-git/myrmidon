// server/src/__tests__/procs/two-api-processes.test.ts
//
// myrmidon(1.6.6 PROCS-T1.5, design BOARD-PROCESSES §7.1): the e2e skeleton of
// "two api processes, one database". Three to four base scenarios only; the
// critical races T1–T8 of the design checklist stay out of scope here.
//
// The suite is a skeleton in the sense that it does not chase the race classes:
// it pins the shape of the fixture (real processes, one shared test database)
// that the later scenarios plug into.

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
  startApiProcesses,
  stopApiProcess,
  stopApiProcesses,
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
    `Skipping the two-process api skeleton on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The registry answers with every live row of the shared database; reading it
 * through a port is how the tests see both processes from one of them. */
async function readBoardProcesses(handle: ApiProcessHandle): Promise<BoardProcessesResponse> {
  const response = await requestApi(handle.baseUrl, "/api/myrmidon/board-processes");
  expect(response.status, `registry read through ${handle.baseUrl}: ${response.text.slice(0, 400)}`).toBe(200);
  return response.json as BoardProcessesResponse;
}

/** The api rows of the shared database, keyed by the port they serve. */
function apiRows(view: BoardProcessesResponse): Map<number, BoardProcessView> {
  const rows = new Map<number, BoardProcessView>();
  for (const row of view.processes) {
    if (row.role === "api" && row.apiPort !== null) rows.set(row.apiPort, row);
  }
  return rows;
}

/** The process-independent projection of a registry view: everything the two
 * processes must agree on because it comes from the one database, with the
 * self-naming and clock-dependent fields dropped. */
function stableRows(view: BoardProcessesResponse): unknown {
  return {
    staleAfterSeconds: (view as { staleAfterSeconds?: number }).staleAfterSeconds,
    processes: [...view.processes]
      .sort((left, right) => left.bootId.localeCompare(right.bootId))
      .map((row) => ({
        bootId: row.bootId,
        role: row.role,
        pid: row.pid,
        hostname: row.hostname,
        container: row.container,
        version: row.version,
        startedAt: row.startedAt,
        apiPort: row.apiPort,
        status: row.status,
      })),
  };
}

describeProcs("two api processes on one test database (PROCS-T1.5 skeleton)", () => {
  let baseDir = "";
  let database: EmbeddedPostgresTestDatabase | null = null;
  let processes: ApiProcessHandle[] = [];

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-procs-t1-5-"));
    let connectionString = externalTestDatabaseUrl;
    if (!connectionString) {
      database = await startEmbeddedPostgresTestDatabase("paperclip-procs-t1-5-");
      connectionString = database.connectionString;
    }
    // Two real api processes against the one test database.
    processes = await startApiProcesses({
      count: 2,
      baseDir,
      connectionString,
      role: "api",
    });
  }, 360_000);

  afterAll(async () => {
    // Children first: they hold pools against the cluster the fixture stops.
    await stopApiProcesses(processes);
    if (database) await database.cleanup();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }, 120_000);

  it("scenario 1: both processes come up on the one database and register in it", async () => {
    // DEBUG
    for (const h of processes) console.log(`=== CHILD ${h.port} OUTPUT ===\n` + h.output());
    for (const handle of processes) {
      const health = await requestApi(handle.baseUrl, "/api/health");
      expect(health.status, `health of ${handle.baseUrl}: ${health.text.slice(0, 400)}`).toBe(200);
    }

    // One database, read through the first port: both processes are there, and
    // the row of the second one is exactly the cross-process write→read proof —
    // it was written by process 2 and is served by process 1.
    const view = await readBoardProcesses(processes[0]);
    const rows = apiRows(view);
    for (const handle of processes) {
      const row = rows.get(handle.port);
      expect(row, `row for the api process on port ${handle.port}`).toBeDefined();
      expect(row?.role).toBe("api");
      expect(row?.status).toBe("live");
    }
    expect(new Set(rows.keys())).toEqual(new Set(processes.map((handle) => handle.port)));

    // Each process answers as itself, and its own boot id names a row of the
    // shared table. The pid of the row is not usable as an identity here: the
    // repository loader starts the entry point in a child of its own, so the
    // pid the test spawns and the pid the process reports differ.
    const selfBootIds: string[] = [];
    for (const handle of processes) {
      const own = await readBoardProcesses(handle);
      selfBootIds.push(own.selfBootId);
      const ownRow = [...apiRows(own).values()].find((row) => row.bootId === own.selfBootId);
      expect(ownRow, `self row of the api process on port ${handle.port}`).toBeDefined();
      expect(ownRow?.apiPort).toBe(handle.port);
      expect(new Set(apiRows(own).keys())).toEqual(new Set(rows.keys()));
    }
    expect(new Set(selfBootIds).size).toBe(processes.length);
    // Both boot ids are visible through the first port: one database, two processes.
    for (const bootId of selfBootIds) {
      expect([...rows.values()].map((row) => row.bootId)).toContain(bootId);
    }

    // Consistency envelope: the two processes report the same deployment and
    // build, because they read the same config/database pair.
    const healthBodies = await Promise.all(
      processes.map(async (handle) => (await requestApi(handle.baseUrl, "/api/health")).json),
    );
    const envelope = healthBodies.map((body) => {
      const health = body as {
        version?: string;
        deploymentMode?: string;
        deploymentExposure?: string;
        authReady?: boolean;
      };
      return {
        version: health.version,
        deploymentMode: health.deploymentMode,
        deploymentExposure: health.deploymentExposure,
        authReady: health.authReady,
      };
    });
    expect(envelope[0]?.version).toBeTruthy();
    expect(new Set(envelope.map((entry) => JSON.stringify(entry))).size).toBe(1);
  }, 120_000);

  it("scenario 2: parallel requests through both ports answer consistently", async () => {
    const rounds = 6;
    const responses = await Promise.all(
      Array.from({ length: rounds }, async () =>
        await Promise.all(processes.map(async (handle) => await readBoardProcesses(handle))),
      ),
    );

    // Every one of the 12 parallel reads succeeded and saw the same database.
    for (const round of responses) {
      const perPort = round.map((view) => apiRows(view));
      for (const rows of perPort) {
        expect(new Set(rows.keys())).toEqual(
          new Set(processes.map((handle) => handle.port)),
        );
      }
      const [first, ...rest] = round;
      expect(rest.length).toBeGreaterThan(0);
      for (const view of rest) {
        // Only the process-naming and time-dependent fields may differ; the
        // database-backed view of "who is up" must be identical.
        expect(stableRows(view)).toEqual(stableRows(first));
      }
    }
  }, 120_000);

  it("scenario 3: SIGTERM drains one process without dropping the other", async () => {
    const [drained, survivor] = processes;

    // Fire the drain and hammer the survivor while the other one leaves.
    const stopPromise = stopApiProcess(drained, { signal: "SIGTERM", timeoutMs: 60_000 });
    const duringDrain = await Promise.all(
      Array.from({ length: 8 }, async () => await requestApi(survivor.baseUrl, "/api/health")),
    );
    for (const response of duringDrain) {
      expect(response.status).toBe(200);
    }

    const stop = await stopPromise;
    expect(stop.drained, `process on port ${drained.port} did not leave within its drain budget:\n${drained.output()}`).toBe(true);
    expect(stop.code).toBe(0);

    // Its port is closed ...
    await expect(requestApi(drained.baseUrl, "/api/health")).rejects.toThrow();
    // ... while the surviving process still serves the shared database.
    const health = await requestApi(survivor.baseUrl, "/api/health");
    expect(health.status).toBe(200);
    const view = await readBoardProcesses(survivor);
    expect(apiRows(view).has(survivor.port)).toBe(true);
  }, 180_000);

  it("scenario 4: the drained process loses nothing the database kept", async () => {
    const [drained, survivor] = processes;
    // The last row the drained process wrote is still there — the drain did not
    // roll the database back, and the survivor serves it.
    const view = await readBoardProcesses(survivor);
    const rows = apiRows(view);
    expect(rows.has(drained.port), `row of the drained process on port ${drained.port}`).toBe(true);
    expect(rows.get(drained.port)?.status).toBe("live"); // the reaper waits 2 minutes (design §5.1)

    // A burst after the drain: the survivor is healthy for every request.
    const burst = await Promise.all(
      Array.from({ length: 8 }, async () => await requestApi(survivor.baseUrl, "/api/health")),
    );
    for (const response of burst) {
      expect(response.status).toBe(200);
    }
  }, 120_000);
});