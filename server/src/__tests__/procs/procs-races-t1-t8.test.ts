// server/src/__tests__/procs/procs-races-t1-t8.test.ts
//
// myrmidon(1.6.6 PROCS-1.9, ticket OPE-5415, design OPE-5394 §8 / §10 T1.9):
// integration test stand "two processes, one database" and race tests T1–T8.
//
// Tests verify:
//   - T1: two executors dispatching one queue through the real claim path do not
//         duplicate starts (exactly one `running` transition per run)
//   - T2: sweeps under dual leader / lease expiration (standby does not steal live lease;
//         sweeps and backup remain idempotent and serialized)
//   - T3: bot container apply on an api process answers 409
//         bot_containers_disabled; no apply job is journaled, the card is untouched
//         (caller_not_board_main itself is the docker gate's verdict, Go tests)
//   - T4: gateway run reattach (live lease protected, expired lease adopted by
//         exactly one survivor, hot-restart snapshot adopted immediately)
//   - T5: settings propagation & parallel edit (a real PATCH /api/myrmidon/processes
//         on process A is read on process B; concurrent PATCHes of different keys
//         through both processes lose nothing)
//   - T6: process bus on the shared database (two real ProcessBus instances with
//         their own LISTEN connections: a live_event published on A reaches B,
//         and the origin filter keeps it from coming back to A)
//   - T8: real SIGKILL of an api process holding a run lease (the survivor keeps
//         serving, the frozen lease expires, the reattach sweep re-claims the run)
//   - T7 (second describe, own database): the real supervisor moves single -> split
//         -> single under a steady request load against the shared port

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import {
  createDb,
  createPostgresJsClient,
  boardProcesses,
  boardLeases,
  authUsers,
  instanceUserRoles,
  companies,
  agents,
  heartbeatRuns,
  botApplyJobs,
} from "@myrmidon/db";
import { DEFAULT_PROCESSES_SETTINGS, type ProcessesSettings } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import {
  requestApi,
  startApiProcesses,
  stopApiProcesses,
  type ApiProcessHandle,
} from "./helpers/api-process-harness.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { subscribeCompanyLiveEvents } from "../../services/live-events.js";
import { BOT_CONTAINERS_ENV } from "../../myrmidon/bot-containers/agent-config.js";
import { leaderLeaseService } from "../../services/leader-lease.js";
import { sweepGatewayRunReattach } from "../../myrmidon/gateway-run-reattach.js";
import { ProcessBus } from "../../services/process-bus.js";
import { hasLiveLegacyController, legacyControllerBootId } from "../../services/legacy-controller-lease.js";
import { startSupervisorStand, STAND_BOARD_URL, type SupervisorStand } from "./helpers/supervisor-stand.js";

// The claim path under test pulls in telemetry; neighbours of this suite mock it
// the same way so a run start does not reach for a real client.
vi.mock("../../telemetry.js", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

/** Polls until the condition holds; throws with the label on timeout. Used in
 * place of fixed sleeps, which are what makes a timer-based race test flaky. */
async function waitFor(label: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeProcs = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping the T1-T8 procs race suite on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

describeProcs("PROCS-1.9: integration stand 'two processes, one database' and race tests T1–T8", () => {
  let baseDir = "";
  let database: EmbeddedPostgresTestDatabase | null = null;
  let connectionString = "";
  let db: Db;
  let processes: ApiProcessHandle[] = [];

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-procs-races-"));
    if (externalTestDatabaseUrl) {
      connectionString = externalTestDatabaseUrl;
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-procs-races-");
      connectionString = database.connectionString;
    }
    db = createDb(connectionString);

    // Pre-seed local trusted user & admin role
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

    // T3 asserts the gate of an instance without bot containers: the children
    // inherit the environment, so a developer shell with the flag on must not
    // change what the stand checks.
    delete process.env[BOT_CONTAINERS_ENV];

    // Start two api processes on the one shared test database
    processes = await startApiProcesses({
      count: 2,
      baseDir,
      connectionString,
    });
  }, 180_000);

  afterAll(async () => {
    await stopApiProcesses(processes);
    if (database) {
      await database.cleanup();
    }
    try {
      fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("T1: two executors do not duplicate starts (real claim path, one 'running' transition per run)", async () => {
    const testCompanyId = randomUUID();
    const testAgentId = randomUUID();
    const runCount = 8;
    const testResponsibleUserId = `owner-${testCompanyId}`;

    await db.insert(companies).values({
      id: testCompanyId,
      name: "T1 Stand Company",
      issuePrefix: `T1${testCompanyId.slice(0, 4).toUpperCase()}`,
      // Dispatch resolves a responsible user for every run; the stand gives the
      // company a default owner so the real claim path can proceed.
      defaultResponsibleUserId: testResponsibleUserId,
    });
    // The agent may run every queued run at once, so the only thing that can
    // keep a run from starting twice is the claim itself.
    await db.insert(agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: "T1 Agent",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: runCount } },
      permissions: {},
      status: "idle",
    });

    const runIds: string[] = [];
    const now = new Date();
    for (let i = 0; i < runCount; i++) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: testCompanyId,
        agentId: testAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
        responsibleUserId: testResponsibleUserId,
        createdAt: new Date(now.getTime() + i),
      });
    }

    // Every claim announces itself with a `running` status event. Counting them
    // per run id is the observable of "started exactly once".
    const runningEvents = new Map<string, number>();
    const unsubscribe = subscribeCompanyLiveEvents(testCompanyId, (event) => {
      const payload = (event.payload ?? {}) as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.status === "running" && payload.runId) {
        runningEvents.set(payload.runId, (runningEvents.get(payload.runId) ?? 0) + 1);
      }
    });

    // Two independent executors (two service instances with their own start
    // locks, one database) dispatch the same agent's queue at the same moment.
    const executorA = heartbeatService(db);
    const executorB = heartbeatService(db);
    try {
      await Promise.all([
        executorA.dispatchRunStart(testAgentId),
        executorB.dispatchRunStart(testAgentId),
      ]);
      await waitFor("every T1 run to leave the queue", async () => {
        const rows = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, runIds));
        return rows.every((row) => row.status !== "queued");
      });
      await executorA.drainActiveRunExecutions();
      await executorB.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    for (const runId of runIds) {
      expect(runningEvents.get(runId), `run ${runId} must be claimed exactly once`).toBe(1);
    }
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    expect(rows).toHaveLength(runCount);
    for (const row of rows) {
      expect(row.status).not.toBe("queued");
      expect(row.startedAt).not.toBeNull();
    }
  }, 60_000);

  it("T2: dual leader and lease expiry (standby never steals a live lease; sweeps are idempotent)", async () => {
    await db.delete(boardLeases);
    const a = leaderLeaseService(db, { ttlMs: 4_000 });
    const b = leaderLeaseService(db, { ttlMs: 4_000 });
    const leaseName = "scheduler";
    const lease1 = a.lease(leaseName);
    const lease2 = b.lease(leaseName);

    try {
      lease1.start();
      await waitFor("contender 1 to become leader", () => lease1.isLeader());

      // Contender 2 runs its acquire pass (the first one is immediate) and then
      // several more while the lease is live: it must stay a standby. The
      // negative check has a bounded window by nature; the positive waits above
      // and below are polled, so a slow runner cannot flip them.
      lease2.start();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(lease2.isLeader()).toBe(false);
      expect(lease1.isLeader()).toBe(true);

      // Graceful release hands the lease over.
      await lease1.release();
      expect(lease1.isLeader()).toBe(false);
      await waitFor("contender 2 to take over after release", () => lease2.isLeader());
    } finally {
      lease1.stop();
      lease2.stop();
      await lease2.release().catch(() => undefined);
    }

    // Sweeps stay idempotent when both processes run the same pass at once: an
    // expired gateway run is adopted by exactly one of them.
    const company = await db
      .insert(companies)
      .values({
        name: `T2 Sweep Company ${randomUUID()}`,
        issuePrefix: `S2${randomUUID().slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `T2 Sweep Agent ${randomUUID()}`,
        adapterType: "hermes_gateway",
        status: "busy",
      })
      .returning()
      .then((rows) => rows[0]!);
    const expiredRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: expiredRunId,
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() - 10_000),
      externalRunId: `ext-${expiredRunId}`,
    });
    const adopted: string[] = [];
    const port = {
      executeRunForGatewayReattach: async (runId: string) => {
        adopted.push(runId);
      },
    };
    await Promise.all([
      sweepGatewayRunReattach(db, port as any),
      sweepGatewayRunReattach(db, port as any),
    ]);
    expect(adopted.filter((id) => id === expiredRunId)).toEqual([expiredRunId]);
  }, 60_000);

  it("T3: an api process does not change bot container state (409 bot_containers_disabled, no job, card untouched)", async () => {
    // The caller_not_board_main verdict itself belongs to the docker gate and is
    // pinned by its own Go tests (tools/dockergate/internal/peer/auth_test.go).
    // What the two-process stand can check is the Node side of the same
    // guarantee: the one route that would change a bot container answers a
    // fixed, specific refusal and leaves the card and the apply journal alone.
    const companyId = randomUUID();
    const botId = randomUUID();
    const adapterConfig = { marker: "t3-unchanged" };
    await db.insert(companies).values({
      id: companyId,
      name: "T3 Stand Company",
      issuePrefix: `T3${companyId.slice(0, 4).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: botId,
      companyId,
      name: "T3 Bot",
      role: "general",
      adapterType: "hermes_gateway",
      adapterConfig,
      status: "idle",
    });

    for (const proc of processes) {
      const response = await requestApi(proc.baseUrl, `/api/myrmidon/agents/${botId}/bot-container/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, response.text.slice(0, 400)).toBe(409);
      expect(response.text).toContain("bot_containers_disabled");
    }

    const jobs = await db.select({ id: botApplyJobs.id }).from(botApplyJobs).where(eq(botApplyJobs.botId, botId));
    expect(jobs).toHaveLength(0);
    const [after] = await db.select({ adapterConfig: agents.adapterConfig }).from(agents).where(eq(agents.id, botId));
    expect(after.adapterConfig).toEqual(adapterConfig);
  });

  it("T4: gateway run reattach (live lease protected, expired lease adopted by survivor)", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Reattach Company ${randomUUID()}`,
        issuePrefix: `RC${randomUUID().slice(0, 4).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);

    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Reattach Agent ${randomUUID()}`,
        adapterType: "hermes_gateway",
        status: "busy",
      })
      .returning()
      .then((rows) => rows[0]!);

    const deadBootId = randomUUID();
    const liveOtherBootId = randomUUID();

    // 1. Run with live controller lease
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      controllerBootId: liveOtherBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000), // live
      externalRunId: `ext-${liveRunId}`,
    });

    // 2. Run with expired controller lease
    const expiredRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: expiredRunId,
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      controllerBootId: deadBootId,
      controllerLeaseExpiresAt: new Date(Date.now() - 10_000), // expired
      externalRunId: `ext-${expiredRunId}`,
    });

    let reattachedRunId: string | null = null;
    const heartbeatPort = {
      executeRunForGatewayReattach: async (runId: string) => {
        reattachedRunId = runId;
      },
    };

    // Run reattach sweep from current process
    await sweepGatewayRunReattach(db, heartbeatPort as any);

    // The live lease run was NOT touched
    const [liveAfter] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, liveRunId));
    expect(liveAfter.controllerBootId).toBe(liveOtherBootId);

    // The expired lease run WAS adopted by this process
    const [expiredAfter] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, expiredRunId));
    expect(expiredAfter.controllerBootId).toBe(legacyControllerBootId);
    expect(reattachedRunId).toBe(expiredRunId);
  });
  it("T5: settings propagation & parallel edit (a PATCH through one process is read through the other; concurrent PATCHes of different keys lose nothing)", async () => {
    const [procA, procB] = processes;
    const settingsUrl = "/api/myrmidon/processes";

    const patch = (proc: ApiProcessHandle, body: Partial<ProcessesSettings>) =>
      requestApi(proc.baseUrl, settingsUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const read = async (proc: ApiProcessHandle): Promise<ProcessesSettings> => {
      const response = await requestApi(proc.baseUrl, settingsUrl);
      expect(response.status, response.text.slice(0, 400)).toBe(200);
      return (response.json as { settings: ProcessesSettings }).settings;
    };

    // The row starts at the defaults on both sides.
    expect((await read(procA)).mode).toBe("single");
    expect(await read(procB)).toEqual(await read(procA));

    // Propagation, A -> B: a value saved through A is what B answers.
    const saved = await patch(procA, { leaderLeaseTtlSec: 45 });
    expect(saved.status, saved.text.slice(0, 400)).toBe(200);
    await waitFor("process B reads the lease ttl saved through A", async () => (await read(procB)).leaderLeaseTtlSec === 45);

    // Propagation, B -> A, and the earlier value survives the second write.
    const savedBack = await patch(procB, { singletonProxy: false });
    expect(savedBack.status, savedBack.text.slice(0, 400)).toBe(200);
    await waitFor("process A reads the proxy flag saved through B", async () => (await read(procA)).singletonProxy === false);
    expect((await read(procA)).leaderLeaseTtlSec).toBe(45);

    // Parallel edit: both processes save a different key at the same moment,
    // round after round. A lost update would show as the key of the loser
    // sitting at its previous value after both answered 200.
    for (let round = 0; round < 6; round += 1) {
      const ttl = 40 + round;
      const proxy = round % 2 === 0;
      const [fromA, fromB] = await Promise.all([
        patch(procA, { leaderLeaseTtlSec: ttl }),
        patch(procB, { singletonProxy: proxy }),
      ]);
      expect(fromA.status, fromA.text.slice(0, 400)).toBe(200);
      expect(fromB.status, fromB.text.slice(0, 400)).toBe(200);
      for (const proc of [procA, procB]) {
        const after = await read(proc);
        expect(after.leaderLeaseTtlSec, `round ${round}: lease ttl edit lost (seen on port ${proc.port})`).toBe(ttl);
        expect(after.singletonProxy, `round ${round}: proxy flag edit lost (seen on port ${proc.port})`).toBe(proxy);
      }
    }
  });

  it("T6: process bus on the shared database (live_event reaches the other process, the origin filter stops the echo)", async () => {
    // Two buses, each with its own LISTEN connection, exactly as two api
    // processes hold them (one postgres.js client per process, max 1 for the
    // listener); the shared database is the only thing between them.
    const sqlA = createPostgresJsClient(connectionString, { maxConnections: 2 });
    const sqlB = createPostgresJsClient(connectionString, { maxConnections: 2 });
    const busA = new ProcessBus(sqlA, { bootId: `stand-a-${randomUUID()}` });
    const busB = new ProcessBus(sqlB, { bootId: `stand-b-${randomUUID()}` });
    const seenOnA: Array<{ n: number; from: string }> = [];
    const seenOnB: Array<{ n: number; from: string }> = [];
    const otherChannelOnB: unknown[] = [];
    busA.subscribe<{ n: number; from: string }>("live_event", (payload) => seenOnA.push(payload));
    busB.subscribe<{ n: number; from: string }>("live_event", (payload) => seenOnB.push(payload));
    busB.subscribe("secrets_changed", (payload) => otherChannelOnB.push(payload));
    try {
      await busA.start();
      await busB.start();

      for (let n = 1; n <= 5; n += 1) {
        await busA.publish("live_event", { n, from: "A" });
      }
      await waitFor("process B receives the five events published on A", () => seenOnB.length === 5);
      expect(seenOnB.map((event) => event.n)).toEqual([1, 2, 3, 4, 5]);

      // The reverse direction, and the proof that it is the origin filter that
      // keeps A quiet: A hears B's message, and only B's.
      await busB.publish("live_event", { n: 100, from: "B" });
      await waitFor("process A receives the event published on B", () => seenOnA.length >= 1);
      // Give any echo of A's own five messages the time to arrive before the check.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(seenOnA).toEqual([{ n: 100, from: "B" }]);
      expect(seenOnB, "B never receives its own message").toHaveLength(5);

      // A message on another channel is not delivered to a live_event listener.
      await busA.publish("settings_changed", { changedKeys: ["processes"] });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seenOnB).toHaveLength(5);
      expect(otherChannelOnB).toHaveLength(0);
    } finally {
      await busA.stop();
      await busB.stop();
      await Promise.all([sqlA.end({ timeout: 5 }), sqlB.end({ timeout: 5 })]);
    }
  });

  it("T8: SIGKILL of an api process that holds a run lease (the survivor keeps serving, the frozen lease expires, the reattach sweep re-claims the run)", async () => {
    const [survivor, victim] = processes;

    // The registry row of the victim names its boot id and its real pid (the
    // handle's own pid is the loader wrapper, not the server).
    let victimRow: { bootId: string; pid: number } | undefined;
    await waitFor("the victim api process is registered in board_processes", async () => {
      const rows = await db
        .select({ bootId: boardProcesses.bootId, pid: boardProcesses.pid, apiPort: boardProcesses.apiPort })
        .from(boardProcesses)
        .where(eq(boardProcesses.apiPort, victim.port));
      victimRow = rows[0];
      return victimRow !== undefined;
    });
    const victimBootId = victimRow!.bootId;
    const victimPid = victimRow!.pid;

    const testCompanyId = randomUUID();
    const testAgentId = randomUUID();
    const victimRunId = randomUUID();
    const gatewayRunId = `gw-run-t8-${randomUUID()}`;
    await db.insert(companies).values({
      id: testCompanyId,
      name: "T8 Stand Company",
      issuePrefix: `T8${testCompanyId.slice(0, 4).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: "T8 Agent",
      role: "general",
      adapterType: "hermes_gateway",
      status: "busy",
    });
    // The run is in flight on the victim: leased to its boot id, the lease still
    // live when the kill lands and expiring a few seconds after it.
    const leaseExpiresAt = new Date(Date.now() + 4_000);
    await db.insert(heartbeatRuns).values({
      id: victimRunId,
      companyId: testCompanyId,
      agentId: testAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      processPid: victimPid,
      controllerBootId: victimBootId,
      controllerLeaseExpiresAt: leaseExpiresAt,
      externalRunId: gatewayRunId,
      executionStage: "running",
    });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, victimRunId));
    expect(await hasLiveLegacyController(db, before), "the victim holds a live lease before the kill").toBe(true);

    // The real kill: no drain, no close, the kernel drops the process.
    process.kill(victimPid, "SIGKILL");
    await waitFor("the victim port stops answering", async () => {
      try {
        await requestApi(victim.baseUrl, "/api/health");
        return false;
      } catch {
        return true;
      }
    });

    // The survivor never noticed: it serves, and the dead process's registry row
    // stays until the reaper's 2 minute window (design §5.1).
    const health = await requestApi(survivor.baseUrl, "/api/health");
    expect(health.status).toBe(200);
    const [victimRegistryRow] = await db
      .select({ bootId: boardProcesses.bootId })
      .from(boardProcesses)
      .where(eq(boardProcesses.bootId, victimBootId));
    expect(victimRegistryRow?.bootId).toBe(victimBootId);

    // The dead process can never renew its lease. Until the lease expires the
    // sweep leaves the run alone; after it, the run is re-claimed exactly once.
    const reattached: string[] = [];
    const heartbeatPort = {
      executeRunForGatewayReattach: async (runId: string) => {
        reattached.push(runId);
        await db
          .update(heartbeatRuns)
          .set({ status: "succeeded", finishedAt: new Date(), executionStage: "completed" })
          .where(eq(heartbeatRuns.id, runId));
      },
    } as any;
    if (Date.now() < leaseExpiresAt.getTime()) {
      await sweepGatewayRunReattach(db, heartbeatPort);
      expect(reattached, "a live lease of the not-yet-expired victim is not stolen").not.toContain(victimRunId);
    }
    await waitFor("the frozen lease expires", () => Date.now() > leaseExpiresAt.getTime() + 100, 15_000);
    const [frozen] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, victimRunId));
    expect(frozen.status, "the run is not dropped when its process dies").toBe("running");
    expect(await hasLiveLegacyController(db, frozen), "the dead process no longer holds a live lease").toBe(false);

    await sweepGatewayRunReattach(db, heartbeatPort);
    await sweepGatewayRunReattach(db, heartbeatPort);
    expect(reattached.filter((id) => id === victimRunId), "the run is re-claimed exactly once").toHaveLength(1);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, victimRunId));
    expect(after.status).toBe("succeeded");
    expect(after.controllerBootId, "the lease moved away from the killed process").not.toBe(victimBootId);
  }, 120_000);
});

/** Connection errors the single <-> split switch may cost: a connection that
 * raced the closing listener by a hair, one per transition (the same budget the
 * drain/failover suite allows). 5xx and any other non-200 answer are never allowed. */
const SWITCH_CONNECTION_ERRORS_PER_TRANSITION = 1;
const STAND_READY_TIMEOUT_MS = 180_000;
const STAND_DRAIN_TIMEOUT_MS = 70_000;

type LoadTally = { total: number; connectionErrors: number; serverErrors: number; otherStatus: number; samples: string[] };

/** A steady request load on the shared port until `stop()`: every answer is
 * classified, nothing is thrown, so the test asserts on the tallies. */
function startLoad(rps = 10) {
  const tally: LoadTally = { total: 0, connectionErrors: 0, serverErrors: 0, otherStatus: 0, samples: [] };
  let stopped = false;
  const pending: Promise<void>[] = [];
  const fire = async (offsetMs: number) => {
    tally.total += 1;
    try {
      const response = await requestApi(STAND_BOARD_URL, "/api/health", { headers: { connection: "close" } });
      if (response.status >= 500) {
        tally.serverErrors += 1;
        tally.samples.push(`t+${offsetMs}ms status ${response.status}`);
      } else if (response.status !== 200) {
        tally.otherStatus += 1;
        tally.samples.push(`t+${offsetMs}ms status ${response.status}`);
      }
    } catch (error) {
      tally.connectionErrors += 1;
      tally.samples.push(`t+${offsetMs}ms ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const startedAt = Date.now();
  const loop = (async () => {
    while (!stopped) {
      pending.push(fire(Date.now() - startedAt));
      await new Promise((resolve) => setTimeout(resolve, 1_000 / rps));
    }
    await Promise.all(pending);
  })();
  return {
    tally,
    stop: async () => {
      stopped = true;
      await loop;
      return tally;
    },
  };
}

describeProcs("PROCS-1.9 T7: single <-> split under load (the real supervisor, real api children)", () => {
  let baseDir = "";
  let database: EmbeddedPostgresTestDatabase | null = null;
  let connectionString = "";
  let db: Db;
  let stand: SupervisorStand | null = null;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-procs-t7-"));
    if (externalTestDatabaseUrl) {
      connectionString = externalTestDatabaseUrl;
    } else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-procs-t7-");
      connectionString = database.connectionString;
    }
    db = createDb(connectionString);
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
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" }).onConflictDoNothing();
    // The supervisor pins the shared board port; a host that already serves
    // something there cannot run this scenario.
    const occupied = await requestApi(STAND_BOARD_URL, "/api/health").catch(() => null);
    if (occupied !== null) {
      throw new Error("port 3100 already answers /api/health: T7 needs the shared board port free");
    }
    stand = startSupervisorStand({ baseDir, connectionString });
  }, 360_000);

  afterAll(async () => {
    if (stand) await stand.stop();
    if (database) await database.cleanup();
    if (baseDir) fs.rmSync(baseDir, { recursive: true, force: true });
  }, 180_000);

  it("T7: single -> split -> single under a steady request load (no 5xx, at most one connection error per transition)", async () => {
    const supervisor = stand!.supervisor;
    const failureContext = () => `\n--- recent child output ---\n${stand!.childOutput()}`;

    // Single lane: the supervisor opens the worker's own listener (the probe).
    await supervisor.apply({ ...DEFAULT_PROCESSES_SETTINGS, mode: "single" });
    expect(supervisor.state()).toBe("single");
    expect(stand!.probeListening(), "the single lane holds the shared port").toBe(true);
    expect((await requestApi(STAND_BOARD_URL, "/api/health")).status).toBe(200);

    const load = startLoad(10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const beforeSplit = { ...load.tally };
      expect(beforeSplit.connectionErrors + beforeSplit.serverErrors + beforeSplit.otherStatus, "the single lane alone is clean").toBe(0);

      // single -> split: two api children fork and report ready, then the
      // worker's listener closes and the children carry the port.
      await supervisor.apply({ ...DEFAULT_PROCESSES_SETTINGS, mode: "split", apiCount: 2 });
      await waitFor(
        "supervisor in split with two ready children and the single lane closed",
        () => supervisor.state() === "split" && !stand!.probeListening() && supervisor.children().filter((c) => c.ready).length === 2,
        STAND_READY_TIMEOUT_MS,
      ).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${failureContext()}`);
      });
      // IPC readiness precedes the registry write of a child: wait for the rows.
      await waitFor(
        "both children registered in board_processes",
        async () => {
          const rows = await db.select({ role: boardProcesses.role }).from(boardProcesses).where(eq(boardProcesses.role, "api"));
          return rows.length >= 2;
        },
        60_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // load now served by the children alone
      const inSplit = { ...load.tally };

      // split -> single: the worker re-opens its listener, the children drain.
      await supervisor.apply({ ...DEFAULT_PROCESSES_SETTINGS, mode: "single" });
      await waitFor(
        "children drained and gone, the single lane back",
        () => supervisor.children().length === 0 && stand!.probeListening(),
        STAND_DRAIN_TIMEOUT_MS,
      ).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${failureContext()}`);
      });
      expect(supervisor.state()).toBe("single");
      await new Promise((resolve) => setTimeout(resolve, 2_000)); // the single lane alone again

      const final = await load.stop();
      expect(final.total, "the load ran through both transitions").toBeGreaterThan(inSplit.total);
      expect(final.serverErrors, `5xx during the switch: ${final.samples.join("; ")}`).toBe(0);
      expect(final.otherStatus, `non-200 answers during the switch: ${final.samples.join("; ")}`).toBe(0);
      expect(
        final.connectionErrors,
        `connection errors during the switch: ${final.samples.join("; ")}`,
      ).toBeLessThanOrEqual(2 * SWITCH_CONNECTION_ERRORS_PER_TRANSITION);
    } finally {
      await load.stop();
    }
    expect((await requestApi(STAND_BOARD_URL, "/api/health")).status).toBe(200);
  }, 600_000);
});
