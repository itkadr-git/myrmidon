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
//  2. kill -9      — SIGKILL on one api child under split=2: the slot restarts
//                    with backoff (a fresh fork at attempt>=1 reports ready
//                    over IPC), not a heartbeat that the restart's boot time
//                    allows is lost, and an in-flight background run leased
//                    to the killed child is not lost forever — its frozen
//                    lease expires and is re-claimed by the supervisory
//                    reattach pass, completing successfully under the fresh
//                    controller (design BOARD-PROCESSES §4.3).
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
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  boardProcesses,
  authUsers,
  instanceUserRoles,
  companies,
  agents,
  issues,
  heartbeatRuns,
} from "@paperclipai/db";
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
import {
  sweepGatewayRunReattach,
  type GatewayRunReattachHeartbeatPort,
} from "../../myrmidon/gateway-run-reattach.js";
import { hasLiveLegacyController } from "../../services/legacy-controller-lease.js";
import {
  createProcessHome,
  REPO_ROOT,
  requestApi,
  resolveTsxCli,
  SERVER_ENTRY,
} from "./helpers/api-process-harness.js";

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

const childLogs: string[] = [];

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
  const tail = childLogs.slice(-25).join("");
  const suffix = tail ? `\n--- Recent child output ---\n${tail}` : "";
  throw new Error(`timed out waiting for ${options.label} (last: ${lastDetail})${suffix}`);
}

/** One heartbeat request against the shared board port. Every failure is
 * data, not an exception — the test asserts on the failure counter. */
async function heartbeat(): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await requestApi(BOARD_URL, "/api/health", {
      headers: { connection: "close" },
    });
    if (response.status === 200) return { ok: true };
    return { ok: false, error: `status ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
      heartbeat().then((res) => {
        if (!res.ok) {
          failed += 1;
          failures.push(`t+${firedAt - startedAt}ms (${res.error ?? "unknown"})`);
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

  function resolveTsxLoader(): string {
    const candidates = [
      path.join(REPO_ROOT, "server", "node_modules", "tsx", "dist", "loader.mjs"),
      path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
      path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "loader.mjs"),
      "/app/node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/loader.mjs",
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
    return path.join(path.dirname(resolveTsxCli()), "loader.mjs");
  }

  const OWNED_ENV_KEYS = [
    "PAPERCLIP_API_KEY",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_TASK_ID",
    "PAPERCLIP_RUN_ID",
    "PAPERCLIP_AGENT_ID",
    "PAPERCLIP_COMPANY_ID",
    "PAPERCLIP_HOME",
    "PAPERCLIP_CONFIG",
    "PAPERCLIP_INSTANCE_ID",
    "PAPERCLIP_PROCESS_ROLE",
    "PAPERCLIP_MIGRATION_AUTO_APPLY",
    "PAPERCLIP_MIGRATION_PROMPT",
    "DATABASE_URL",
    "PORT",
  ] as const;

  function openProbeListener(): Promise<SupervisorListenerHandle> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      const sockets = new Set<net.Socket>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: BOARD_PORT, reusePort: true }, () => {
        probeServer = server;
        resolve({
          get listening() {
            return server.listening;
          },
          close: () =>
            new Promise<void>((resolveClose) => {
              for (const socket of sockets) {
                socket.destroy();
              }
              sockets.clear();
              server.close(() => resolveClose());
            }),
          closeIdleConnections: () => undefined,
          closeAllConnections: () => {
            for (const socket of sockets) {
              socket.destroy();
            }
            sockets.clear();
          },
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

    // Pre-seed the local trusted principal so multiple api children starting
    // concurrently at split=2 do not race on ensureLocalTrustedBoardPrincipal
    // (duplicate key on "user_pkey").
    const now = new Date();
    await db
      .insert(authUsers)
      .values({
        id: "local-board",
        name: "Board",
        email: "local@paperclip.local",
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await db
      .insert(instanceUserRoles)
      .values({
        userId: "local-board",
        role: "instance_admin",
      })
      .onConflictDoNothing();

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

    const tsxLoader = resolveTsxLoader();
    let childIndex = 0;

    supervisor = createProcessSupervisor({
      openPublicListener: openProbeListener,
      drainPublicListener: async (handle) => {
        await handle.close();
        handle.closeIdleConnections();
        handle.closeAllConnections();
        probeServer = null;
      },
      // The fork starts the real production entry (SERVER_ENTRY) with role=api
      // and an isolated instance home/config, hooked via IPC to the supervisor.
      forkChild: (env, execArgv) => {
        const index = ++childIndex;
        const home = createProcessHome({
          baseDir,
          index,
          port: BOARD_PORT,
          connectionString,
        });
        const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const key of OWNED_ENV_KEYS) delete cleanEnv[key];

        const child = fork(SERVER_ENTRY, [], {
          cwd: REPO_ROOT,
          env: {
            ...cleanEnv,
            ...env,
            NODE_ENV: process.env.NODE_ENV ?? "test",
            PORT: String(BOARD_PORT),
            PAPERCLIP_HOME: home.dir,
            PAPERCLIP_INSTANCE_ID: home.instanceId,
            PAPERCLIP_CONFIG: home.configPath,
            DATABASE_URL: connectionString,
            PAPERCLIP_PROCESS_ROLE: "api",
            PAPERCLIP_MIGRATION_PROMPT: "never",
            SERVE_UI: "false",
            PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
            PAPERCLIP_OPEN_ON_LISTEN: "false",
          },
          execArgv: [
            ...execArgv,
            "--import",
            "data:text/javascript,if(typeof%20process.send==='function')process.send=process.send.bind(process);",
            "--import",
            pathToFileURL(tsxLoader).href,
            "--max-old-space-size=1024",
          ],
          silent: true,
        });
        const prefix = `child#${index}`;
        const record = (chunk: Buffer) => {
          const str = chunk.toString("utf8");
          process.stderr.write(`[${prefix}] ${str}`);
          childLogs.push(`[${prefix}] ${str}`);
          if (childLogs.length > 100) childLogs.shift();
        };
        child.stdout?.on("data", record);
        child.stderr?.on("data", record);
        if (child.pid) forkedPids.push(child.pid);
        return child;
      },
      // Real timers: the backoff ladder and the drain grace are the production
      // timings the design promises, and the suite exists to observe them.
      setTimeout,
      clearTimeout,
      log: {
        debug: () => undefined,
        info: (fields: object, message: string) => console.log(`[supervisor:info] ${message}`, fields),
        warn: (fields: object, message: string) => console.warn(`[supervisor:warn] ${message}`, fields),
        error: (fields: object, message: string) => console.error(`[supervisor:error] ${message}`, fields),
      },
    });
  }, 360_000);

  afterAll(async () => {
    if (supervisor) await supervisor.shutdown();
    for (const pid of forkedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    if (probeServer?.listening) {
      await new Promise<void>((resolve) => probeServer!.close(() => resolve()));
    }
    if (db) {
      try {
        await db.delete(heartbeatRuns);
        await db.delete(issues);
        await db.delete(agents);
        await db.delete(companies);
      } catch {
        // ignore on teardown
      }
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
        const slots = supervisor!.children();
        if (slots.length < 2 || !slots.every((s) => typeof s.pid === "number" && s.pid > 0 && s.ready)) {
          return `${slots.length} slots, ${slots.filter((s) => s.ready).length} ready`;
        }
        const pids = slots.map((s) => s.pid!);
        const rows = await db
          .select({ bootId: boardProcesses.bootId, pid: boardProcesses.pid })
          .from(boardProcesses)
          .where(eq(boardProcesses.role, "api"));
        const registeredPids = rows.map((r) => r.pid);
        if (!pids.every((pid) => registeredPids.includes(pid))) {
          return `waiting for initial children [${pids.join(", ")}] in board_processes, have [${registeredPids.join(", ")}]`;
        }
        if (supervisor!.state() !== "split") return `supervisor state: ${supervisor!.state()}`;
        if (probeServer?.listening) return "probe listener still open";
        return true;
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "two api children registered and supervisor split" },
    );
    expect(supervisor!.state()).toBe("split");

    const initialSlots = supervisor!.children();
    expect(initialSlots.length, "two initial slots").toBe(2);
    const initialPids = initialSlots
      .map((s) => s.pid)
      .filter((pid): pid is number => typeof pid === "number" && pid > 0);
    expect(initialPids.length, "two initial running child pids").toBe(2);

    // Warm up the public port so both children have compiled routes, initialized
    // connection pools, and cached git metadata before measuring drain load:
    await waitFor(
      async () => {
        const res = await heartbeat();
        return res.ok ? true : `warmup heartbeat failed: ${res.error}`;
      },
      { timeoutMs: 30_000, label: "api children serving /api/health" },
    );
    for (let i = 0; i < 20; i++) {
      const res = await heartbeat();
      if (!res.ok) {
        throw new Error(`warmup heartbeat ${i} failed: ${res.error}`);
      }
    }

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
    // Wait for the supervisor's async startup transition to finish closing its
    // own reuse-port listener before draining a child, keeping the survivor's
    // health probe from racing that listener handoff.
    await waitFor(
      () => supervisor!.state() === "split" ? true : `supervisor state is ${supervisor!.state()}`,
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "supervisor public-listener handoff" },
    );
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
    drainedPid = initialPids.find((pid) => pid !== survivorPid)!;
    expect(drainedPid, "the drained child's pid is known from initial slots").toBeGreaterThan(0);

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

  it("scenario 2: kill -9 one api child under split=2 — the survivor keeps serving, the slot restarts with backoff, in-flight background run is re-claimed by lease without loss", async () => {
    expect(survivorPid, "survivor pid from scenario 1 is known").toBeGreaterThan(0);
    expect(drainedPid, "drained pid from scenario 1 is known").toBeGreaterThan(0);

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

    // The supervisor's ready IPC is emitted only after the child has completed
    // its awaited initial registry tick. Keep polling for the row to tolerate
    // database scheduling without treating readiness and persistence as a race.
    await waitFor(
      async () => {
        const [row] = await db
          .select({ bootId: boardProcesses.bootId })
          .from(boardProcesses)
          .where(eq(boardProcesses.pid, victimPid));
        return row?.bootId
          ? true
          : "victim process registry row not published yet";
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "victim child registered in board_processes" },
    );
    const [victimRow] = await db
      .select({ bootId: boardProcesses.bootId })
      .from(boardProcesses)
      .where(eq(boardProcesses.pid, victimPid));
    expect(victimRow?.bootId, "victim bootId is registered in board_processes").toBeDefined();
    const victimBootId = victimRow!.bootId;

    // Warm up the grown child so both children are actively serving /api/health before load:
    await waitFor(
      async () => {
        const res = await heartbeat();
        return res.ok ? true : `warmup heartbeat failed: ${res.error}`;
      },
      { timeoutMs: 30_000, label: "grown api child serving /api/health" },
    );
    for (let i = 0; i < 20; i++) {
      const res = await heartbeat();
      if (!res.ok) {
        throw new Error(`warmup heartbeat ${i} before kill failed: ${res.error}`);
      }
    }

    // Seed a real in-flight background run leased to the victim child:
    const failoverCompanyId = randomUUID();
    const failoverAgentId = randomUUID();
    const failoverIssueId = randomUUID();
    const failoverRunId = randomUUID();
    const failoverGatewayRunId = `gw-run-failover-${randomUUID()}`;

    await db.insert(companies).values({
      id: failoverCompanyId,
      name: "Failover Lease Test",
      issuePrefix: `FL${failoverCompanyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: failoverAgentId,
      companyId: failoverCompanyId,
      name: "Failover Agent",
      role: "general",
      adapterType: "hermes_gateway",
      status: "busy",
    });
    await db.insert(issues).values({
      id: failoverIssueId,
      companyId: failoverCompanyId,
      title: "Background task under failover",
      status: "in_progress",
      assigneeAgentId: failoverAgentId,
    });

    // Run is in-flight on the victim child: leased to victimBootId, PID is victimPid,
    // TTL is short (2.5 s) so it is live when the kill lands and expires during restart.
    const initialLeaseExpiresAt = new Date(Date.now() + 2_500);
    await db.insert(heartbeatRuns).values({
      id: failoverRunId,
      companyId: failoverCompanyId,
      agentId: failoverAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      processPid: victimPid,
      controllerBootId: victimBootId,
      controllerLeaseExpiresAt: initialLeaseExpiresAt,
      externalRunId: failoverGatewayRunId,
      contextSnapshot: { issueId: failoverIssueId },
      executionStage: "running",
    });

    const [preKillRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, failoverRunId));
    expect(preKillRun.status, "background run is running before kill").toBe("running");
    expect(preKillRun.controllerBootId, "run is leased to victim child").toBe(victimBootId);
    expect(preKillRun.processPid, "run PID matches victim child").toBe(victimPid);
    expect(await hasLiveLegacyController(db, preKillRun), "victim holds a live controller lease").toBe(true);

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
    const slotsAfter = supervisor!.children();
    const restartedSlot = slotsAfter.find(
      (slot) => slot.pid !== victimPid && slot.pid !== survivorPid,
    )!;
    expect(restartedSlot?.pid, "restarted child pid is known").toBeGreaterThan(0);
    const freshPid = restartedSlot.pid!;
    expect(freshPid).not.toBe(victimPid);
    expect(freshPid).not.toBe(survivorPid);

    // The survivor never left its slot.
    expect(slotsAfter.map((slot) => slot.pid)).toContain(survivorPid);

    // Failover proof on the data path: every row the suite wrote is still
    // served — the drained row (scenario 1), the grown child's row, the
    // killed child's row (reaper waits 2 min), and the restarted child's
    // fresh row. Scoped to the suite's own pids so a reused external database
    // cannot break the count.
    const ownPids = [drainedPid, survivorPid, victimPid, freshPid];
    await waitFor(
      async () => {
        const rows = await db
          .select({ bootId: boardProcesses.bootId, role: boardProcesses.role, pid: boardProcesses.pid })
          .from(boardProcesses);
        const apiRows = rows.filter((row) => row.role === "api");
        const count = apiRows.filter((row) => ownPids.includes(row.pid!)).length;
        return count === 4 ? true : `expected 4 api rows in board_processes, found ${count}`;
      },
      { timeoutMs: SPLIT_READY_TIMEOUT_MS, label: "restarted child registered in board_processes" },
    );
    const rows = await db
      .select({ bootId: boardProcesses.bootId, role: boardProcesses.role, pid: boardProcesses.pid })
      .from(boardProcesses);
    const apiRows = rows.filter((row) => row.role === "api");
    expect(
      apiRows.filter((row) => ownPids.includes(row.pid!)).length,
      "drained + survivor + killed (grown) + restarted rows all present (reaper waits 2 min)",
    ).toBe(4);
    expect(apiRows.map((row) => row.pid)).toContain(victimPid); // dead row survives until the reaper
    expect(apiRows.map((row) => row.pid)).toContain(survivorPid);
    expect(apiRows.map((row) => row.pid)).toContain(freshPid);
    expect(apiRows.map((row) => row.pid)).toContain(drainedPid);

    // Resolve the restarted child's bootId from the process registry:
    const [freshProcessRow] = await db
      .select({ bootId: boardProcesses.bootId })
      .from(boardProcesses)
      .where(eq(boardProcesses.pid, freshPid));
    expect(freshProcessRow?.bootId, "fresh child bootId is registered").toBeDefined();
    const freshBootId = freshProcessRow!.bootId;
    expect(freshBootId).not.toBe(victimBootId);

    // Failover assertion on the execution path (OPE-6984 requirement):
    // 1. The killed process can never renew its lease; wait for the frozen lease to expire.
    await waitFor(
      () => Date.now() > initialLeaseExpiresAt.getTime(),
      { timeoutMs: 5_000, label: "victim lease expired" },
    );
    const [deadLeaseRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, failoverRunId));
    expect(deadLeaseRun.status, "run was not dropped from DB when process died").toBe("running");
    expect(await hasLiveLegacyController(db, deadLeaseRun), "dead victim process no longer holds live lease").toBe(false);

    // 2. The run is re-claimed by the supervisory reattach sweep (design BOARD-PROCESSES §4.3):
    //    The sweep observes the expired lease of the dead controller, atomically transfers
    //    the controller lease to the active controller, records the reattach context marker,
    //    and re-dispatches the execution.
    const reattachedCalls: Array<{ runId: string; gatewayRunId: string }> = [];
    const heartbeatPort: GatewayRunReattachHeartbeatPort = {
      executeRunForGatewayReattach: async (reclaimRunId, reclaimGatewayRunId) => {
        reattachedCalls.push({ runId: reclaimRunId, gatewayRunId: reclaimGatewayRunId });
        // Complete the re-dispatched run on behalf of the surviving / restarted controller
        await db
          .update(heartbeatRuns)
          .set({
            status: "succeeded",
            finishedAt: new Date(),
            executionStage: "completed",
            resultJson: {
              outcome: "reclaimed_after_failover",
              reclaimedFromBootId: victimBootId,
              adoptedByBootId: freshBootId,
            },
          })
          .where(eq(heartbeatRuns.id, reclaimRunId));
      },
    };

    const sweepResult = await sweepGatewayRunReattach(db, heartbeatPort);
    expect(sweepResult.reattached, "orphan run was reclaimed by sweep").toBe(1);
    expect(reattachedCalls).toEqual([{ runId: failoverRunId, gatewayRunId: failoverGatewayRunId }]);

    // 3. Verify the reclaimed run's durable outcome in the database:
    //    - Reached terminal success (never lost forever)
    //    - Controller lease transferred away from the dead child
    //    - Context marker records reattach gateway run id
    //    - finishedAt and resultJson verify completion after failover
    const [finalRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, failoverRunId));
    expect(finalRun.status, "reclaimed run reached terminal success").toBe("succeeded");
    expect(finalRun.controllerBootId, "lease is no longer held by victim").not.toBe(victimBootId);
    expect(finalRun.finishedAt, "run recorded finishedAt").not.toBeNull();
    expect(finalRun.resultJson).toMatchObject({
      outcome: "reclaimed_after_failover",
      reclaimedFromBootId: victimBootId,
      adoptedByBootId: freshBootId,
    });

    // And the board is healthy through the crash aftermath.
    const health = await requestApi(BOARD_URL, "/api/health");
    expect(health.status).toBe(200);
  }, 420_000);
});
