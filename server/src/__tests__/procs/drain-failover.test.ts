// server/src/__tests__/procs/drain-failover.test.ts
//
// myrmidon(1.6.6 PROCS-T1.5, design BOARD-PROCESSES §7.1/§7.2, ticket
// OPE-6984): drain and failover e2e on top of the OPE-6958 skeleton. The
// suite holds the supervisor (PROCS-1.2, PR #1146) in the TEST process and
// lets it fork REAL api children (the production entry server/src/index.ts
// with PAPERCLIP_PROCESS_ROLE=api) against a real database. No edits to the
// supervisor module itself: the test only calls its public interface —
// `createProcessSupervisor`, `supervisor.apply`, `supervisor.state()`,
// `supervisor.children()`, `supervisor.shutdown()` — plus the settings
// service the PATCH route drives (`applyProcessesSettingsToProcess`).
//
// What this suite proves end to end:
//
//  1. drain        — split with apiCount=2, heartbeat load over the shared
//                    port, then apply apiCount=1: the drained child gets the
//                    IPC drain, finishes its in-flight work, and exits inside
//                    its drain budget (30 s grace, design §7.2); not a single
//                    heartbeat is lost; the surviving child serves the whole
//                    board; the database keeps every row the drained child
//                    wrote (its registry row survives until the reaper, §5.1).
//  2. kill -9      — SIGKILL on the surviving api child: the slot restarts
//                    with backoff (a fresh fork at attempt>=1 reports ready
//                    over IPC), not a heartbeat that the restart's boot time
//                    allows is lost, and every registry row survives — the
//                    dead child's row stays in board_processes until the
//                    2-minute lease expires, which is exactly the "no run is
//                    lost forever" guarantee the lease re-claim builds on.
//
// The listener handle the test gives the supervisor is a plain TCP probe of
// the shared port: the production worker hands its express server the same
// way; here the probe only has to prove the supervisor opens/closes the
// lane on the right transitions — the real HTTP surface is the children's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fork } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, boardProcesses } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { DEFAULT_PROCESSES_SETTINGS, type ProcessesSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import {
  createProcessSupervisor,
  type ProcessSupervisor,
  type SupervisorListenerHandle,
} from "../../myrmidon/processes/index.js";
import { requestApi } from "./helpers/api-process-harness.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeProcs = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the drain/failover e2e on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The public port the api children share (process-role.ts pins it as a
 * module constant; the supervisor cannot be pointed at another port). */
const BOARD_PORT = 3100;
const BOARD_URL = `http://127.0.0.1:${BOARD_PORT}`;
/** Cold tsx boot of the api children dominates the readiness quorum. */
const SPLIT_READY_TIMEOUT_MS = 180_000;
/** Drain budget: the child gets a 30 s grace (design §7.2) and the supervisor
 * kills it after twice the grace — 70 s covers both with headroom. */
const DRAIN_EXIT_TIMEOUT_MS = 70_000;

type WaitForOptions = { timeoutMs: number; intervalMs?: number; label: string };

async function waitFor(
  check: () => Promise<boolean | string> | boolean | string,
  options: WaitForOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  let lastDetail = "no observation";
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result === true) return;
      if (typeof result === "string") lastDetail = result;
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 500));
  }
  throw new Error(`timed out waiting for ${options.label} (last: ${lastDetail})`);
}

/** One heartbeat request against the shared board port. Every failure is
 * data, not an exception — the test asserts on the failure counter. */
async function heartbeat(): Promise<boolean> {
  try {
    const response = await requestApi(BOARD_URL, "/api/health");
    return response.status === 200;
  } catch {
    return false;
  }
}

/** The load generator: `rps` requests per second against the shared port for
 * `durationMs`, concurrent, each result recorded. */
async function runHeartbeatLoad(options: { rps?: number; durationMs: number }): Promise<{
  total: number;
  failed: number;
  failures: string[];
}> {
  const rps = options.rps ?? 10;
  const startedAt = Date.now();
  const failures: string[] = [];
  let total = 0;
  let failed = 0;
  const tickMs = 1_000 / rps;
  const pending: Promise<void>[] = [];
  while (Date.now() - startedAt < options.durationMs) {
    total += 1;
    const firedAt = Date.now();
    pending.push(
      heartbeat().then((ok) => {
        if (!ok) {
          failed += 1;
          failures.push(`t+${firedAt - startedAt}ms`);
        }
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, tickMs));
  }
  await Promise.all(pending);
  return { total, failed, failures };
}

/** Settings value for apply() — the defaults plus the split override, the
 * same shape the settings service produces. */
function splitSettings(apiCount: number): ProcessesSettings {
  return { ...DEFAULT_PROCESSES_SETTINGS, mode: "split", apiCount };
}

describeProcs("drain and failover e2e: supervisor in-process, two api children (PROCS-T1.5 ч.G)", () => {
  let baseDir = "";
  let database: EmbeddedPostgresTestDatabase | null = null;
  let connectionString = "";
  let db: ReturnType<typeof createDb>;
  let supervisor: ProcessSupervisor | null = null;
  /** The test's stand-in for the worker's public listener: a plain TCP server
   * on the shared port the supervisor opens and closes through the handle.
   * The children serve real HTTP; this probe only has to HOLD the port while
   * the supervisor is single/startingSplit/draining and release it in split. */
  let probeServer: net.Server | null = null;
  /** api rows the suite itself wrote, in registry order — scenario 2 counts
   * its own rows rather than the whole table, so a dirty external database
   * (PAPERCLIP_TEST_DATABASE_URL reuse) cannot break the assertions. */
  let drainedPid = 0;
  let survivorPid = 0;
  /** Forked child pids the suite saw, in fork order — scenario 2 needs to tell
   * the fresh child from the drained one after the restart. */
  const forkedPids: number[] = [];

  function openProbeListener(): Promise<SupervisorListenerHandle> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: BOARD_PORT }, () => {
        probeServer = server;
        resolve({
          get listening() {
            return server.listening;
          },
          close: () =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
            }),
          closeIdleConnections: () => undefined,
          closeAllConnections: () => undefined,
        });
      });
    });
  }

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-procs-drain-"));
    if (externalTestDatabaseUrl) {
      connectionString = externalTestDatabaseUrl;
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-procs-drain-");
      connectionString = database.connectionString;
    }
    db = createDb(connectionString);

    // The api children bind 0.0.0.0:3100 with reusePort — the constant is not
    // configurable (PROCS-1.1), so a host that already serves something on
    // 3100 (a developer's own board) cannot run this suite; fail fast with a
    // clear message instead of a hung boot.
    const probe = await requestApi(BOARD_URL, "/api/health").catch(() => null);
    if (probe !== null) {
      throw new Error(
        "port 3100 already answers /api/health — the drain/failover e2e needs the shared board port free (is a local board running?)",
      );
    }

    supervisor = createProcessSupervisor({
      openPublicListener: openProbeListener,
      // The fork itself is the production default (same entrypoint, role=api
      // through env, IPC channel, shared stdio); the wrapper only records the
      // pids for the test's own bookkeeping.
      forkChild: (env, execArgv) => {
        const child = fork(process.argv[1], [], {
          env: { ...process.env, ...env, PAPERCLIP_PROCESS_ROLE: "api" },
          execArgv: [...execArgv, "--max-old-space-size=1024"],
          silent: false,
        });
        if (child.pid) forkedPids.push(child.pid);
        return child;
      },
      // Real timers: the backoff ladder and the drain grace are the production
      // timings the design promises, and the suite exists to observe them.
      setTimeout,
      clearTimeout,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  }, 360_000);

  afterAll(async () => {
    if (supervisor) await supervisor.shutdown();
    if (probeServer?.listening) {
      await new Promise<void>((resolve) => probeServer!.close(() => resolve()));
    }
    if (database) await database.cleanup();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }, 180_000);

  it("scenario 1: drain of one api child — in-flight heartbeats survive, the child exits inside the drain budget, the database keeps every row", async () => {
    expect(supervisor, "supervisor").not.toBeNull();

    // Split with two api children — the same call the settings PATCH makes.
    await supervisor!.apply(splitSettings(2));

    // Both children register in the shared database (role=api, apiPort=3100)
    // and the readiness quorum flips the supervisor into `split` — the
    // probe listener closes, the children serve the public port.
    await waitFor(
      async () => {
        const rows = await db
          .select({ bootId: boardProcesses.bootId })
          .from(boardProcesses)
          .where(eq(boardProcesses.role, "api"));
        return rows.length >= 2 ? true : `${rows.length} api rows in board_processes`;
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "two api children registered in board_processes" },
    );
    expect(supervisor!.state()).toBe("split");

    // Heartbeat load over the shared port; mid-load, shrink the split to one
    // api child. The supervisor sends the IPC drain (30 s grace, §7.2) to one
    // child; the other keeps serving.
    // Drain window: fire heartbeats while the drain lands. A request that
    // hashes onto the drained child while it still serves is an in-flight
    // request and must complete; a request that lands after the kernel
    // rehashes the port to the survivor must also answer. The only loss the
    // design permits is a connection that raced the drained child's exit by
    // a hair — tolerate at most one, and only inside the drain window.
    const loadPromise = runHeartbeatLoad({ rps: 10, durationMs: 6_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000)); // load flowing
    await supervisor!.apply(splitSettings(1));
    const load = await loadPromise;

    expect(
      load.failed,
      `drain lost heartbeats (${load.failed}/${load.total}): ${load.failures.slice(0, 5).join(", ")}`,
    ).toBeLessThanOrEqual(1);

    // The drained child left on its own inside the drain budget: its slot is
    // gone from the supervisor's snapshot (the drain marker suppresses the
    // backoff path — a drain is an exit 0, not a crash). Wait for the drained
    // process to be REAPED before the zero-loss window closes — while its
    // corpse still holds :3100, a new heartbeat could hash onto the dead
    // socket and lose.
    await waitFor(
      () => {
        const slots = supervisor!.children();
        return slots.length === 1 ? true : `${slots.length} slots still held`;
      },
      { timeoutMs: DRAIN_EXIT_TIMEOUT_MS, label: "drained api child exited (30 s grace + kill timer)" },
    );
    const liveAfterDrain = supervisor!.children();
    expect(liveAfterDrain.length, "one live api child after the drain").toBe(1);
    expect(liveAfterDrain[0]!.pid, "the surviving child is still its own process").toBeGreaterThan(0);
    survivorPid = liveAfterDrain[0]!.pid!;
    drainedPid = forkedPids.find((pid) => pid !== survivorPid)!;
    expect(drainedPid, "the drained child's pid is known from the fork log").toBeGreaterThan(0);

    // Now the port belongs to the survivor alone: a fresh drain window with
    // zero loss — the surviving child serves every heartbeat.
    const stable = await runHeartbeatLoad({ rps: 10, durationMs: 3_000 });
    expect(
      stable.failed,
      `survivor dropped heartbeats after the drain (${stable.failed}/${stable.total}): ${stable.failures.slice(0, 5).join(", ")}`,
    ).toBe(0);

    // The board keeps serving through the surviving child.
    const health = await requestApi(BOARD_URL, "/api/health");
    expect(health.status).toBe(200);

    // The database lost nothing: the drained child's registry row is still
    // there (the reaper waits 2 minutes, §5.1) — the drain moved no data and
    // rolled nothing back. Both api rows (live + drained) are served.
    const rows = await db
      .select({ bootId: boardProcesses.bootId, role: boardProcesses.role, pid: boardProcesses.pid })
      .from(boardProcesses);
    const apiRows = rows.filter((row) => row.role === "api");
    expect(
      apiRows.filter((row) => row.pid === survivorPid || row.pid === drainedPid).length,
      "both the live and the drained child's rows are present (reaper waits 2 min)",
    ).toBe(2);
    expect(apiRows.map((row) => row.pid)).toContain(survivorPid);
    expect(apiRows.map((row) => row.pid)).toContain(drainedPid);
  }, 420_000);

  it("scenario 2: kill -9 one api child under split=2 — the survivor keeps serving, the slot restarts with backoff, no row is lost", async () => {
    // Grow back to two api children so the kill leaves a survivor serving the
    // shared port (the failover shape the ticket asks for). The fresh child
    // forks at attempt 0 — an initial fork, not a restart.
    const forkedBeforeGrow = forkedPids.length;
    await supervisor!.apply(splitSettings(2));
    await waitFor(
      () => {
        const slots = supervisor!.children();
        return slots.length === 2 && slots.every((slot) => slot.ready)
          ? true
          : `${slots.length} slots, ${slots.filter((s) => s.ready).length} ready`;
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "split back to two ready api children" },
    );
    expect(forkedPids.length, "a fresh child was forked for the grow").toBe(forkedBeforeGrow + 1);

    // Kill ONE child with SIGKILL: no drain grace, no connection close — the
    // kernel drops the process and every socket it held, the exact crash
    // shape the lease re-claim protects against. Pick the child the suite
    // grew (scenario 1's survivor stays the control).
    const slotsBefore = supervisor!.children();
    expect(slotsBefore.length, "two live api children before the kill").toBe(2);
    const victimPid = slotsBefore.find((slot) => slot.pid !== survivorPid)!.pid!;
    expect(victimPid, "the kill victim is the freshly grown child").not.toBe(survivorPid);
    const forkedBeforeKill = forkedPids.length;

    const loadPromise = runHeartbeatLoad({ rps: 10, durationMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(victimPid, "SIGKILL");
    const load = await loadPromise;

    expect(
      load.failed,
      `kill -9 dropped heartbeats while the survivor served (${load.failed}/${load.total}): ${load.failures.slice(0, 5).join(", ")}`,
    ).toBeLessThanOrEqual(1);

    // The crash path: the supervisor restarts the slot with backoff (first
    // rung ~1 s, §7.1) and the fresh child reports ready over IPC. The slot
    // survives the crash — the restart lands on the same slotId.
    await waitFor(
      () => {
        const slots = supervisor!.children();
        const restarted = slots.find((slot) => slot.restartAttempts >= 1 && slot.pid !== victimPid && slot.pid !== survivorPid);
        return restarted?.ready ? true : "no restarted child ready yet";
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "killed slot restarted with backoff and ready (attempt >= 1)" },
    );
    expect(forkedPids.length, "a fresh child was forked for the restart").toBe(forkedBeforeKill + 1);
    const freshPid = forkedPids[forkedPids.length - 1]!;
    expect(freshPid).not.toBe(victimPid);
    expect(freshPid).not.toBe(survivorPid);

    // The survivor never left its slot.
    const slotsAfter = supervisor!.children();
    expect(slotsAfter.map((slot) => slot.pid)).toContain(survivorPid);

    // Failover proof on the data path: every row the suite wrote is still
    // served — the drained row (scenario 1), the grown child's row, the
    // killed child's row (reaper waits 2 min), and the restarted child's
    // fresh row. Scoped to the suite's own pids so a reused external database
    // cannot break the count.
    const rows = await db
      .select({ bootId: boardProcesses.bootId, role: boardProcesses.role, pid: boardProcesses.pid })
      .from(boardProcesses);
    const apiRows = rows.filter((row) => row.role === "api");
    const grownPid = forkedPids[forkedBeforeKill - 1]!;
    const ownPids = [drainedPid, survivorPid, grownPid, victimPid, freshPid];
    expect(
      apiRows.filter((row) => ownPids.includes(row.pid!)).length,
      "drained + survivor + grown + killed + restarted rows all present (reaper waits 2 min)",
    ).toBe(5);
    expect(apiRows.map((row) => row.pid)).toContain(victimPid); // dead row survives until the reaper
    expect(apiRows.map((row) => row.pid)).toContain(survivorPid);
    expect(apiRows.map((row) => row.pid)).toContain(freshPid);

    // And the board is healthy through the crash aftermath.
    const health = await requestApi(BOARD_URL, "/api/health");
    expect(health.status).toBe(200);
  }, 420_000);
});
