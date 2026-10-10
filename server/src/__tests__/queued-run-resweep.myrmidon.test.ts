import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listAgentsWithQueuedRunsAndNoRunningRun } from "../myrmidon/run-dispatch/index.ts";

// myrmidon(1.6.6 RUN-DISPATCH, OPE-6443): the database-facing half of part A of
// T1.4 — the "queued without running" selection and the lift of a queued run that
// no notification will ever start. The pure half is in
// run-dispatch-inline-resweep.myrmidon.test.ts.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Queued resweep test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>(
    "../adapters/index.ts",
  );
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("queued run resweep (part A of T1.4)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-queued-resweep-");
    db = createDb(tempDb.connectionString);
    // Same shape as the other myrmidon heartbeat suites: the resweep timer is off
    // under the test runner, and this suite drives the pass by hand.
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  afterEach(async () => {
    // Wait for every run this file dispatched to finish writing its rows, then
    // drop the runs that were left queued on purpose: a leftover queued row would
    // be selected by the next test's pass and make that pass serve more than one
    // agent (changing the vendor fair-share hint).
    await heartbeat.drainActiveRunExecutions();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"));
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(status = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * A run that sits in the queue with no notification behind it — the state the
   * resweep exists for. Inserted directly on purpose: `wakeup()` would start it.
   */
  async function seedQueuedRun(
    companyId: string,
    agentId: string,
    options: { createdAt?: Date } = {},
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { source: "automation", wakeReason: "queued_resweep_probe" },
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    });
    return runId;
  }

  async function seedRunningRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      startedAt: new Date(),
    });
    return runId;
  }

  async function readRun(runId: string) {
    const [run] = await db
      .select({ status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    return run ?? null;
  }

  async function waitForRunToLeaveQueue(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await readRun(runId);
      if (run && run.status !== "queued") return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await readRun(runId);
  }

  it("selects the agents with a queued run and no running run", async () => {
    const waiting = await seedAgent();
    const busy = await seedAgent();
    const runningOnly = await seedAgent();
    await seedQueuedRun(waiting.companyId, waiting.agentId);
    await seedQueuedRun(busy.companyId, busy.agentId);
    await seedRunningRun(busy.companyId, busy.agentId);
    await seedRunningRun(runningOnly.companyId, runningOnly.agentId);

    const selected = await listAgentsWithQueuedRunsAndNoRunningRun(db);
    const agentIds = selected.map((row) => row.agentId);

    expect(agentIds).toContain(waiting.agentId);
    expect(agentIds).not.toContain(busy.agentId);
    expect(agentIds).not.toContain(runningOnly.agentId);
    expect(
      selected.every(
        (row) => row.oldestQueuedAt instanceof Date && !Number.isNaN(row.oldestQueuedAt.getTime()),
      ),
    ).toBe(true);
  });

  it("honours the worktree execution cutoff in the selection", async () => {
    const fresh = await seedAgent();
    const stale = await seedAgent();
    const staleQueuedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await seedQueuedRun(fresh.companyId, fresh.agentId);
    await seedQueuedRun(stale.companyId, stale.agentId, { createdAt: staleQueuedAt });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const agentIds = (await listAgentsWithQueuedRunsAndNoRunningRun(db, { cutoff })).map(
      (row) => row.agentId,
    );

    expect(agentIds).toContain(fresh.agentId);
    expect(agentIds).not.toContain(stale.agentId);
  });

  it("lifts a queued run whose agent has no running run: the lost notification", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);

    // Control: nothing else in the process starts this run. It waits until the
    // resweep finds it — exactly the NOTIFY fallback of the design (line 140).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await readRun(runId))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const outcome = await heartbeat.sweepQueuedRunsWithoutRunning();

    expect(outcome.agents).toBeGreaterThanOrEqual(1);
    expect(outcome.started).toBeGreaterThanOrEqual(1);
    expect(outcome.failed).toBe(0);

    const run = await waitForRunToLeaveQueue(runId);
    expect(["running", "succeeded"]).toContain(run?.status);
    expect(run?.startedAt).not.toBeNull();
  });

  it("starts nothing on a second pass: the run is no longer queued", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);

    expect((await heartbeat.sweepQueuedRunsWithoutRunning()).started).toBe(1);
    await waitForRunToLeaveQueue(runId);

    const second = await heartbeat.sweepQueuedRunsWithoutRunning();

    expect(second).toEqual({ agents: 0, started: 0, failed: 0 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(1);
  });

  it("does not start a queued run of an agent that already has a running run", async () => {
    const { companyId, agentId } = await seedAgent();
    const queuedRunId = await seedQueuedRun(companyId, agentId);
    await seedRunningRun(companyId, agentId);

    const outcome = await heartbeat.sweepQueuedRunsWithoutRunning();

    expect(outcome).toEqual({ agents: 0, started: 0, failed: 0 });
    expect((await readRun(queuedRunId))?.status).toBe("queued");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });
});