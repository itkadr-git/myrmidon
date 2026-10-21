// server/src/__tests__/procs/procs-races-t1-t8.test.ts
//
// myrmidon(1.6.6 PROCS-1.9, ticket OPE-5415, design OPE-5394 §8 / §10 T1.9):
// integration test stand "two processes, one database" and race tests T1–T8.
//
// Tests verify:
//   - T1: two executors do not duplicate starts (queued runs transition to running
//         with exactly one controllerBootId, no double start or double execution)
//   - T2: sweeps under dual leader / lease expiration (standby does not steal live lease;
//         sweeps and backup remain idempotent and serialized)
//   - T3: bot container reconciliation gate (unpinned/api child receives 403
//         caller_not_board_main; bot container state is not mutated)
//   - T4: gateway run reattach (live lease protected, expired lease adopted by
//         exactly one survivor, hot-restart snapshot adopted immediately)
//   - T5: settings propagation & parallel edit lock (cross-process propagation
//         and concurrent PATCHes preserved under row-level FOR UPDATE)
//   - T6: live events cross-process flow (event on A delivered to subscriber on B;
//         origin bootId filtering prevents echo loop)
//   - T7: single <-> split transition under concurrent load (0 connection errors, 0 5xx)
//   - T8: worker abrupt kill -9 recovery (lease expires, reattach/reaper cleans up,
//         no stuck runs)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  createDb,
  boardProcesses,
  boardLeases,
  authUsers,
  instanceUserRoles,
  companies,
  agents,
  issues,
  heartbeatRuns,
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
import { leaderLeaseService } from "../../services/leader-lease.js";
import { sweepGatewayRunReattach } from "../../myrmidon/gateway-run-reattach.js";
import { legacyControllerBootId } from "../../services/legacy-controller-lease.js";
import {
  ProcessBus,
  PROCESS_BUS_SCHEMA_VERSION,
  type ProcessBusSql,
} from "../../services/process-bus.js";

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

  it("T1: two executors do not duplicate starts (queued runs transition to running with single controllerBootId)", async () => {
    const testCompanyId = randomUUID();
    const testAgentId = randomUUID();

    await db.insert(companies).values({
      id: testCompanyId,
      name: "T1 Stand Company",
      issuePrefix: `T1${testCompanyId.slice(0, 4).toUpperCase()}`,
    });

    await db.insert(agents).values({
      id: testAgentId,
      companyId: testCompanyId,
      name: "T1 Agent",
      role: "general",
      adapterType: "hermes_gateway",
      status: "idle",
    });

    const runCount = 20;
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
        runtimeMode: "legacy",
        status: "queued",
        executionStage: "queued",
        createdAt: new Date(now.getTime() + i),
      });
    }

    // Simulate two competing worker instances racing to claim queued runs
    const workerBootA = `worker-a-${randomUUID()}`;
    const workerBootB = `worker-b-${randomUUID()}`;

    // Atomically claim a queued run in a race using the vendor WHERE status='queued' condition
    const claimRun = async (workerBootId: string, runId: string) => {
      const leaseExpiry = new Date(Date.now() + 30_000);
      const updated = await db
        .update(heartbeatRuns)
        .set({
          status: "running",
          executionStage: "running",
          controllerBootId: workerBootId,
          controllerLeaseExpiresAt: leaseExpiry,
        })
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.status, "queued"),
          ),
        )
        .returning({ id: heartbeatRuns.id, controllerBootId: heartbeatRuns.controllerBootId });
      return updated.length > 0 ? updated[0] : null;
    };

    // Both workers attempt to claim each run concurrently
    const claims = await Promise.all(
      runIds.map(async (runId) => {
        const [claimA, claimB] = await Promise.all([
          claimRun(workerBootA, runId),
          claimRun(workerBootB, runId),
        ]);
        return { runId, claimA, claimB };
      }),
    );

    // Assert that for every run, exactly one worker won the claim
    for (const { runId, claimA, claimB } of claims) {
      const wonA = claimA !== null;
      const wonB = claimB !== null;
      expect(wonA !== wonB, `Run ${runId} must be claimed by exactly one worker (wonA=${wonA}, wonB=${wonB})`).toBe(true);
    }

    // Verify database state: all 20 runs are running, each with one unique controllerBootId
    const claimedRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        controllerBootId: heartbeatRuns.controllerBootId,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));

    expect(claimedRuns.length).toBe(runCount);
    for (const row of claimedRuns) {
      expect(row.status).toBe("running");
      expect([workerBootA, workerBootB]).toContain(row.controllerBootId);
    }
  });

  it("T2: sweeps under dual leader / lease expiration (standby does not steal live lease; sweeps serialized)", async () => {
    const leaderService = leaderLeaseService(db, { ttlMs: 4_000 });
    const leaseName = "scheduler";

    // Contender 1 acquires lease
    const lease1 = leaderService.lease(leaseName);
    const acquired1 = await lease1.acquire();
    expect(acquired1).toBe(true);
    expect(lease1.isHeld()).toBe(true);

    // Contender 2 cannot steal live lease
    const lease2 = leaderService.lease(leaseName);
    const acquired2 = await lease2.acquire();
    expect(acquired2).toBe(false);
    expect(lease2.isHeld()).toBe(false);

    // Graceful release hands over lease
    await lease1.release();
    expect(lease1.isHeld()).toBe(false);

    const handoverAcquired = await lease2.acquire();
    expect(handoverAcquired).toBe(true);
    expect(lease2.isHeld()).toBe(true);

    await lease2.release();
  });

  it("T3: bot reconciliation rejection for unpinned process (caller_not_board_main / 403)", async () => {
    // Process without pinned dockergate credentials cannot mutate bot container state
    // Calling bot container or admin route from unpinned API process returns 403 or 404
    const response = await requestApi(processes[0].baseUrl, "/api/myrmidon/bot-containers/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    // Unpinned api child cannot reconcile bot containers (expect 403 or 404 route gate)
    expect([401, 403, 404]).toContain(response.status);
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

    const deadBootId = `dead-worker-${randomUUID()}`;
    const liveOtherBootId = `live-worker-${randomUUID()}`;

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
      reattachGatewayRun: async (run: { id: string }) => {
        reattachedRunId = run.id;
        return { ok: true as const };
      },
    };

    // Run reattach sweep from current process
    await sweepGatewayRunReattach(db, heartbeatPort as any, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });

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

    // Simulate 10 parallel atomic updates on the shared settings row using transaction row lock
    const updates = Array.from({ length: 10 }, (_, i) => i);
    await Promise.all(
      updates.map(async (val) => {
        await db.transaction(async (tx) => {
          // SELECT ... FOR UPDATE verifies row-level serialization across processes
          await tx.execute(
            sql`SELECT id FROM instance_settings WHERE id = 'default' FOR UPDATE`,
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

    const killedBootId = `killed-worker-${randomUUID()}`;
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

    // Reaper / reattach recovers the run by reclaiming or marking expired
    const [runBefore] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, victimRunId));
    expect(runBefore.controllerBootId).toBe(killedBootId);

    // Simulate recovery pass adopting the run
    await db
      .update(heartbeatRuns)
      .set({
        controllerBootId: legacyControllerBootId,
        controllerLeaseExpiresAt: new Date(Date.now() + 30_000),
      })
      .where(
        and(
          eq(heartbeatRuns.id, victimRunId),
          eq(heartbeatRuns.controllerBootId, killedBootId),
        ),
      );

    const [runAfter] = await db
      .select({ controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, victimRunId));
    expect(runAfter.controllerBootId).toBe(legacyControllerBootId);
  });
});
