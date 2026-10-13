import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Two-process notify test run.",
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
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
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
