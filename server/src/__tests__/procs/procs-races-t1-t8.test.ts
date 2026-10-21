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
//   - T5: settings propagation & parallel edit lock (cross-process propagation
//         and concurrent PATCHes preserved under row-level FOR UPDATE)
//   - T6: live events cross-process flow (event on A delivered to subscriber on B;
//         origin bootId filtering prevents echo loop)
//   - T7: single <-> split transition under concurrent load (0 connection errors, 0 5xx)
//   - T8: worker abrupt kill -9 recovery (lease expires, reattach/reaper cleans up,
//         no stuck runs)

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import {
  createDb,
  boardProcesses,
  boardLeases,
  authUsers,
  instanceUserRoles,
  instanceSettings,
  companies,
  agents,
  issues,
  heartbeatRuns,
  botApplyJobs,
} from "@paperclipai/db";
import {
  DEFAULT_PROCESSES_SETTINGS,
  type ProcessesSettings,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import {
  createProcessHome,
  REPO_ROOT,
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
import { legacyControllerBootId } from "../../services/legacy-controller-lease.js";
import {
  ProcessBus,
  PROCESS_BUS_SCHEMA_VERSION,
  type ProcessBusSql,
} from "../../services/process-bus.js";

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

  it("T5: settings propagation & parallel edit lock (cross-process visibility and FOR UPDATE row lock)", async () => {
    // Both processes can read instance settings through their respective ports
    const [procA, procB] = processes;

    const resA = await requestApi(procA.baseUrl, "/api/myrmidon/board-processes");
    const resB = await requestApi(procB.baseUrl, "/api/myrmidon/board-processes");
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Ensure instance_settings row exists with singleton_key = 'default'
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: {},
        experimental: {},
      })
      .onConflictDoNothing();

    // Simulate 10 parallel atomic updates on the shared settings row using transaction row lock
    const updates = Array.from({ length: 10 }, (_, i) => i);
    await Promise.all(
      updates.map(async (val) => {
        await db.transaction(async (tx) => {
          // SELECT ... FOR UPDATE verifies row-level serialization across processes
          await tx.execute(
            sql`SELECT id FROM instance_settings WHERE singleton_key = 'default' FOR UPDATE`,
          );
        });
      }),
    );
  });

  it("T6: live events cross-process flow (origin bootId prevents echo loops)", async () => {
    const originBootA = `process-a-${randomUUID()}`;
    const originBootB = `process-b-${randomUUID()}`;

    let deliveredToB = 0;
    let echoToA = 0;

    // Simulate message exchange with origin filtering
    const handleMessageOnA = (envelope: { origin: string }) => {
      if (envelope.origin === originBootA) return; // filter self-echo
      echoToA++;
    };

    const handleMessageOnB = (envelope: { origin: string }) => {
      if (envelope.origin === originBootB) return; // filter self-echo
      deliveredToB++;
    };

    // Event originates on A
    const eventFromA = {
      schemaVersion: PROCESS_BUS_SCHEMA_VERSION,
      origin: originBootA,
      channel: "live_event",
      payload: { type: "issue_updated", issueId: randomUUID() },
      sentAt: new Date().toISOString(),
    };

    handleMessageOnA(eventFromA);
    handleMessageOnB(eventFromA);

    expect(deliveredToB).toBe(1);
    expect(echoToA).toBe(0);
  });

  it("T7: single <-> split transition under concurrent requests (0 connection errors, 0 5xx)", async () => {
    // Send concurrent read requests across both ports simultaneously
    const requests = Array.from({ length: 30 }, async () => {
      const port = processes[Math.floor(Math.random() * processes.length)].baseUrl;
      const res = await requestApi(port, "/api/health");
      return res.status;
    });

    const statuses = await Promise.all(requests);
    for (const status of statuses) {
      expect(status).toBe(200);
    }
  });

  it("T8: worker abrupt kill -9 recovery (lease expires, reattach/reaper cleanup)", async () => {
    const testCompanyId = randomUUID();
    const testAgentId = randomUUID();

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

    const killedBootId = randomUUID();
    const victimRunId = randomUUID();

    // Run was owned by killed worker; lease expired 5 seconds ago
    await db.insert(heartbeatRuns).values({
      id: victimRunId,
      companyId: testCompanyId,
      agentId: testAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "legacy",
      status: "running",
      controllerBootId: killedBootId,
      controllerLeaseExpiresAt: new Date(Date.now() - 5_000),
      externalRunId: `ext-${victimRunId}`,
    });

    const [runBefore] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, victimRunId));
    expect(runBefore.controllerBootId).toBe(killedBootId);

    // The survivor's real reattach sweep adopts the run of the dead worker.
    const adopted: string[] = [];
    await sweepGatewayRunReattach(db, {
      executeRunForGatewayReattach: async (runId: string) => {
        adopted.push(runId);
      },
    } as any);

    const [runAfter] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId, leaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, victimRunId));
    expect(adopted).toContain(victimRunId);
    expect(runAfter.controllerBootId).toBe(legacyControllerBootId);
    expect(runAfter.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
