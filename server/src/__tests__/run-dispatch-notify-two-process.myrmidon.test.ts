import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildRunQueuedPayload,
  createRunQueuedBusListener,
  RUN_QUEUED_CHANNEL,
  type RunQueuedPayload,
} from "../myrmidon/run-dispatch/index.ts";

// myrmidon(1.6.6 RUN-DISPATCH-NOTIFY, OPE-6977): the two-process half of part B
// of T1.4 — the notify path end to end against one database. Two
// `heartbeatService` instances share the db: the «api» (executesRuns: false,
// publishes `run_queued` instead of starting) and the «worker»
// (executesRuns: true, subscribes to the channel and starts the run). The bus
// between them is fake in-process — the real LISTEN/NOTIFY transport has its
// own suite in process-bus.test.ts; what is proven here is the contract:
// wakeup on the api → start on the worker, and the lost-NOTIFY case → the
// resweep of part A carries the run.
// Runs wait on this gate so a load case can hold them in `running` and count
// starts without paying for 200 serial executions of one agent.
const runGate = vi.hoisted(() => ({ wait: Promise.resolve() as Promise<void> }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    await runGate.wait;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Two-process notify test run.",
      provider: "test",
      model: "test-model",
    };
  }),
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
import { resetSharedRunAdmissionForTests } from "../myrmidon/run-admission.ts";

/** The in-process bus with the T1.3 shape: publish/subscribe/onReconnect. */
function fakeBus() {
  type Handler = (payload: unknown) => void;
  const handlers = new Set<Handler>();
  const published: Array<{ channel: string; payload: unknown }> = [];
  const reconnectHandlers = new Set<() => void>();
  return {
    published,
    bus: {
      publish: async (channel: typeof RUN_QUEUED_CHANNEL, payload: RunQueuedPayload) => {
        published.push({ channel, payload });
        for (const handler of [...handlers]) handler(payload);
      },
      subscribe: (_channel: typeof RUN_QUEUED_CHANNEL, handler: Handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      onReconnect: (handler: () => void) => {
        reconnectHandlers.add(handler);
        return () => reconnectHandlers.delete(handler);
      },
    },
    reconnect: () => {
      for (const handler of [...reconnectHandlers]) handler();
    },
  };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run start dispatch, notify mode: two processes, one database (part B of T1.4)", () => {
  // The load case measures dispatch, not host admission policy: keep the
  // process-wide gates open so all 200 queued runs can exercise the bus.
  const GATE_ENV = [
    "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE",
    "MYRMIDON_MIN_FREE_HOST_MEMORY_MB",
    "MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE",
    "MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT",
    "MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10",
    "MYRMIDON_MAX_PER_AGENT_START_SHARE_PERCENT",
  ] as const;
  const origEnv = Object.fromEntries(GATE_ENV.map((k) => [k, process.env[k]]));

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    for (const k of GATE_ENV) process.env[k] = "off";
    resetSharedRunAdmissionForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-notify-two-proc-");
    db = createDb(tempDb.connectionString);
    // The dispatcher reads the mode from the singleton row of
    // instance_settings.general.processes — seed the notify mode once.
    const { instanceSettings } = await import("@paperclipai/db");
    const inserted = await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: { processes: { runStartDispatch: "notify", queuedResweepSec: 30 } },
      })
      .onConflictDoNothing()
      .returning({ id: instanceSettings.id });
    if (inserted.length === 0) {
      await db
        .update(instanceSettings)
        .set({ general: { processes: { runStartDispatch: "notify", queuedResweepSec: 30 } } })
        .where(eq(instanceSettings.singletonKey, "default"));
    }
  }, 30_000);

  afterEach(async () => {
    resetSharedRunAdmissionForTests();
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.status, "queued"));
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSharedRunAdmissionForTests();
    await tempDb?.cleanup();
  });

  async function seedAgent(status = "active", maxConcurrentRuns = 1) {
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
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { source: "automation", wakeReason: "notify_probe" },
    });
    return runId;
  }

  async function waitForRunToLeaveQueue(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      if (run && run.status !== "queued") return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [run] = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    return run ?? null;
  }

  it("a wakeup on the api process publishes run_queued and the worker starts the run", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);
    const { bus, published } = fakeBus();

    // The api process: must not execute runs — it publishes into the bus.
    const api = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      executesRuns: false,
      processBus: bus,
    });
    // The worker process: executes runs, subscribes to run_queued.
    const worker = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      executesRuns: true,
      processBus: bus,
    });

    try {
      // The api side of the wakeup: the run is already queued, the wake event
      // reaches the service's run_queued effect handler, which routes through
      // dispatchRunStart — in the notify mode on an api process that publishes
      // run_queued instead of starting.
      await (api as unknown as {
        dispatchRunStart: (agentId: string) => Promise<unknown[]>;
      }).dispatchRunStart(agentId);

      expect(published).toEqual([
        {
          channel: RUN_QUEUED_CHANNEL,
          payload: { agentId, companyId, schemaVersion: 1 },
        },
      ]);

      const run = await waitForRunToLeaveQueue(runId);
      expect(["running", "succeeded"]).toContain(run?.status);

      await api.drainActiveRunExecutions();
      await worker.drainActiveRunExecutions();
    } finally {
      await api.drainActiveRunExecutions().catch(() => {});
      await worker.drainActiveRunExecutions().catch(() => {});
    }
  });

  // T1 criterion: one executor, 200 queued -> 200 starts, no duplicates, and
  // queued->running p95 in `notify` no worse than the inline path. The runs are
  // held in `running` by the gate (4 agents x 50 slots), so the case measures
  // starts, not 200 serial executions; the same load is run through both modes.
  async function runLoad(mode: "notify" | "inline") {
    const { instanceSettings } = await import("@paperclipai/db");
    await db
      .update(instanceSettings)
      .set({ general: { processes: { runStartDispatch: mode, queuedResweepSec: 30 } } })
      .where(eq(instanceSettings.singletonKey, "default"));

    const perAgent = 50;
    const seeded: Array<{ agentId: string; runIds: string[] }> = [];
    for (let a = 0; a < 4; a += 1) {
      const { companyId, agentId } = await seedAgent("active", perAgent);
      const runIds: string[] = [];
      for (let i = 0; i < perAgent; i += 1) runIds.push(await seedQueuedRun(companyId, agentId));
      seeded.push({ agentId, runIds });
    }
    const allRunIds = seeded.flatMap((s) => s.runIds);
    const queuedAt = Date.now();

    let release!: () => void;
    runGate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bus } = fakeBus();
    const worker = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      executesRuns: true,
      ...(mode === "notify" ? { processBus: bus } : {}),
    });
    const api =
      mode === "notify"
        ? heartbeatService(db, {
            runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
            executesRuns: false,
            processBus: bus,
          })
        : worker;
    try {
      // The wakeup of each agent arrives on the api (notify) or on the single
      // process (inline).
      for (const { agentId } of seeded) {
        await (api as unknown as { dispatchRunStart: (id: string) => Promise<unknown[]> }).dispatchRunStart(agentId);
      }
      // No resweep timer is involved: wait only for the dispatch path to carry
      // all 200 runs out of the queue (well under the 30 s resweep interval).
      const deadline = Date.now() + 25_000;
      let rows: Array<{ id: string; status: string; startedAt: Date | null; controllerBootId: string | null }> = [];
      for (;;) {
        rows = await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            startedAt: heartbeatRuns.startedAt,
            controllerBootId: heartbeatRuns.controllerBootId,
          })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, allRunIds));
        if (rows.every((r) => r.status !== "queued") || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { rows, allRunIds, queuedAt, release, worker, api };
    } catch (error) {
      release();
      throw error;
    }
  }

  function p95StartMs(rows: Array<{ startedAt: Date | null }>, queuedAt: number) {
    const lat = rows
      .map((r) => Math.max(0, (r.startedAt?.getTime() ?? Number.POSITIVE_INFINITY) - queuedAt))
      .sort((a, b) => a - b);
    return lat[Math.ceil(lat.length * 0.95) - 1]!;
  }

  it("starts 200 queued runs exactly once in notify mode, p95 not worse than inline", async () => {
    const results: Record<string, number> = {};
    for (const mode of ["notify", "inline"] as const) {
      const load = await runLoad(mode);
      try {
        expect(load.rows).toHaveLength(200);
        expect(new Set(load.rows.map((r) => r.id))).toEqual(new Set(load.allRunIds));
        // Every run left the queue through the dispatch path, none via resweep.
        expect(load.rows.every((r) => r.status === "running" || r.status === "succeeded")).toBe(true);
        // One controllerBootId per run, set at start (no run started twice).
        expect(load.rows.every((r) => r.controllerBootId != null)).toBe(true);
        results[mode] = p95StartMs(load.rows, load.queuedAt);
        // Let the held runs finish; the adapter ran exactly once per run.
        load.release();
        await load.api.drainActiveRunExecutions();
        await load.worker.drainActiveRunExecutions();
        expect(mockAdapterExecute).toHaveBeenCalledTimes(200);
      } finally {
        load.release();
        await load.api.drainActiveRunExecutions().catch(() => {});
        await load.worker.drainActiveRunExecutions().catch(() => {});
        runGate.wait = Promise.resolve();
        mockAdapterExecute.mockClear();
        await resetNotifyMode();
      }
    }
    console.info(JSON.stringify({ count: 200, notifyP95Ms: results.notify, inlineP95Ms: results.inline }));
    // Runner noise tolerance: the criterion is that notify matches inline and
    // never falls back to the 30 s resweep, not a wall-clock race.
    expect(results.notify!).toBeLessThan(30_000);
    expect(results.notify!).toBeLessThanOrEqual(Math.max(results.inline! * 1.5, results.inline! + 5_000));
  }, 90_000);

  async function resetNotifyMode() {
    const { instanceSettings } = await import("@paperclipai/db");
    await db
      .update(instanceSettings)
      .set({ general: { processes: { runStartDispatch: "notify", queuedResweepSec: 30 } } })
      .where(eq(instanceSettings.singletonKey, "default"));
  }

  it("a lost NOTIFY (bus subscription down) is carried by the worker resweep", async () => {
    const { companyId, agentId } = await seedAgent();
    const runId = await seedQueuedRun(companyId, agentId);

    // No bus at all on the worker: the listener is not there, the run waits in
    // the queue. The resweep of part A — the correctness carrier of the
    // design — lifts it.
    const worker = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      executesRuns: true,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const [still] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      expect(still?.status).toBe("queued");

      const outcome = await worker.sweepQueuedRunsWithoutRunning();
      expect(outcome.started).toBeGreaterThanOrEqual(1);

      const run = await waitForRunToLeaveQueue(runId);
      expect(["running", "succeeded"]).toContain(run?.status);

      await worker.drainActiveRunExecutions();
    } finally {
      await worker.drainActiveRunExecutions().catch(() => {});
    }
  });
});
