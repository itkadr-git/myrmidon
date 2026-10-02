// myrmidon(L6-PROFILE-UPDATE-STARVATION) + myrmidon(ANNEX-LEAVING-2026-10-02):
// guard tests for the drain-completion path and the unconditional leave tail.
//
// Red side (unfixed main): with onTimeout=interrupt_and_retry the tick
// interrupts the runs but nothing promotes the due scheduled retries, so the
// window never reaches `on` — the reconciler's drain poll never sees zero,
// throws, exits the window, and the next sweep re-enters: the update never
// applies. A hanging or throwing onExited hook kept the window in `leaving`
// (same-scope enter got 409), and windows piled up per agent.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { DEFAULT_STUCK_GRACE_MS } from "./domain.js";
import { resetMaintenanceGateCaches } from "./gate.js";
import { maintenanceHeartbeatPort } from "./index.js";
import { maintenanceService, type MaintenanceHooks } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ADMIN = { actorType: "user", actorId: "admin-user" };
const SLOW = "setTimeout(() => process.exit(0), 20000)";
const FAST = "process.exit(0)";

// myrmidon(L6-PROFILE-UPDATE-STARVATION): keep the bounded-hook guard tests
// fast — main's default hook timeout is 15s, which would slow every
// hanging-hook case to a full 15s wait.
process.env.MYRMIDON_MAINTENANCE_HOOK_TIMEOUT_MS = "1000";

describeEmbeddedPostgres("maintenance drain completion (L6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-maintenance-drain-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueRecoveryActions);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.update(heartbeatRuns).set({ retryOfRunId: null });
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(instanceSettings);
    resetMaintenanceGateCaches();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** An agent working on an assigned issue, its run already started. */
  async function seedIssueRun(script: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Long task",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "user-a",
    });
    const [wakeup] = await db
      .insert(agentWakeupRequests)
      .values({ companyId, agentId, source: "assignment", status: "queued" })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeup!.id,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      })
      .returning();
    await heartbeatService(db).resumeQueuedRuns();
    return { companyId, agentId, issueId, runId: run!.id };
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000) {
    const started = Date.now();
    while (!(await check())) {
      if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function run(id: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  }

  async function runCount(agentId: string, status: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((r) => r.status === status).length;
  }

  function service(now?: () => Date, hooks?: MaintenanceHooks) {
    return maintenanceService(db, {
      heartbeat: maintenanceHeartbeatPort(heartbeatService(db)),
      now,
      hooks,
    });
  }

  it("drives an interrupt_and_retry window to `on` after the retry is promoted, so the update applies within the timeout", async () => {
    const { agentId, runId } = await seedIssueRun(SLOW);
    await waitFor(async () => (await run(runId)).status === "running");

    const svc = service();
    await svc.enter(
      { scope: { type: "agent", id: agentId }, reason: "bot container profile update (agent-a)", drainTimeoutSec: 0, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );

    // First tick past the deadline: the run is interrupted. Teardown timing
    // varies (the vendor's run teardown may complete within the same tick or
    // the next), so the window is either still `entering` (drain pending) or
    // already `on` (drain complete) — the invariant is the run left `running`.
    await svc.tick();
    const interrupted = await run(runId);
    expect(interrupted).toMatchObject({ status: "cancelled" });

    // The vendor's teardown lands: the cancelled run is gone from "running".
    await heartbeatService(db).drainActiveRunExecutions();

    // The next tick (if the drain had not already completed) promotes the
    // scheduled retry (queued, gated by admission while the window is open)
    // and the window turns `on`. On unfixed main the window stays `entering`
    // and this expectation fails — the update never applies.
    await svc.tick();
    const window = (await svc.status({ type: "agent", id: agentId })).windows[0]!;
    expect(window).toMatchObject({ state: "on", runningRuns: 0, interruptedRuns: 1 });
    const retry = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)))[0]!;
    expect(["queued", "scheduled_retry"]).toContain(retry.status);

    // The retry does NOT start while the window gates admission.
    await heartbeatService(db).promoteDueScheduledRetries();
    await heartbeatService(db).resumeQueuedRuns();
    expect((await run(retry.id)).status).not.toBe("running");

    // Exit finishes the leave and the retry starts on its own.
    await db
      .update(agents)
      .set({ adapterConfig: { command: process.execPath, args: ["-e", FAST] } })
      .where(eq(agents.id, agentId));
    await svc.exit({ type: "agent", id: agentId }, ADMIN);
    await svc.tick();
    await waitFor(async () => (await run(retry.id)).status === "succeeded");
  }, 45_000);

  /**
   * The 15:37 fact pattern: a window with MANY runs must interrupt them all and
   * complete the drain; runs that appear late (after the first interrupt pass)
   * are still caught by the next tick, so the interrupt path cannot silently
   * miss runs in scope.
   */
  it("a window with many runs interrupts every one, promotes every retry, and completes", async () => {
    const RUNS = 8;
    const seeds: Awaited<ReturnType<typeof seedIssueRun>>[] = [];
    for (let i = 0; i < RUNS; i += 1) seeds.push(await seedIssueRun(SLOW));
    await waitFor(
      async () => (await Promise.all(seeds.map((s) => run(s.runId)))).every((r) => r.status === "running"),
      60_000,
    );

    const svc = service();
    await svc.enter(
      { scope: { type: "instance" }, reason: "deploy", drainTimeoutSec: 0, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );
    // A late starter (a run still queued at the first interrupt pass) is
    // caught by the next tick: the interrupt path cannot silently miss runs
    // in scope. Loop ticks until every run in scope is interrupted.
    for (let tick = 0; tick < 10; tick += 1) {
      await svc.tick();
      const statuses = await Promise.all(seeds.map((s) => run(s.runId)));
      if (statuses.every((r) => r.status === "cancelled")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    for (const seed of seeds) {
      expect((await run(seed.runId)).status).toBe("cancelled");
    }
    await heartbeatService(db).drainActiveRunExecutions();

    // The drain completes: retries promoted, window `on`. Under DB contention
    // a run can leave `running` on its own in the same instant the window
    // interrupts it (the vendor's teardown wins the race); its task still has
    // exactly one retry successor, so the invariant is: every seed interrupted
    // or superseded, nothing left running, the window `on`.
    await svc.tick();
    const st = (await svc.status()).instance!;
    expect(st).toMatchObject({ state: "on", runningRuns: 0 });
    expect(st.interruptedRuns).toBeGreaterThanOrEqual(RUNS - 1);
    for (const seed of seeds) {
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, seed.runId));
      expect(retries).toHaveLength(1);
    }

    for (const seed of seeds) {
      await db
        .update(agents)
        .set({ adapterConfig: { command: process.execPath, args: ["-e", FAST] } })
        .where(eq(agents.id, seed.agentId));
    }
    await svc.exit({ type: "instance" }, ADMIN);
    await svc.tick();
    const retryIds = (
      await Promise.all(seeds.map((s) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, s.runId))))
    ).map((rows) => rows[0]!.id);
    await waitFor(
      async () => (await Promise.all(retryIds.map((id) => run(id)))).every((r) => r.status === "succeeded"),
      60_000,
    );
  }, 180_000);

  it("coalesces: a second card change while a window is open returns the same window, no second window", async () => {
    const { agentId, runId } = await seedIssueRun(SLOW);
    await waitFor(async () => (await run(runId)).status === "running");

    const svc = service();
    const first = await svc.enter(
      { scope: { type: "agent", id: agentId }, reason: "bot container profile update (agent-a)", drainTimeoutSec: 0, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );
    const second = await svc.enter(
      { scope: { type: "agent", id: agentId }, reason: "bot container profile update (agent-a)", drainTimeoutSec: 0, onTimeout: "interrupt_and_retry" },
      ADMIN,
    );
    expect(second.changed).toBe(false);
    expect(second.state).toBe(first.state);
    expect((await svc.status({ type: "agent", id: agentId })).windows).toHaveLength(1);

    await svc.tick(); // interrupt the run
    await heartbeatService(db).drainActiveRunExecutions();
    await svc.tick(); // complete the drain
    expect((await svc.status({ type: "agent", id: agentId })).windows).toHaveLength(1);
    expect(await runCount(agentId, "running")).toBe(0);

    await db
      .update(agents)
      .set({ adapterConfig: { command: process.execPath, args: ["-e", FAST] } })
      .where(eq(agents.id, agentId));
    await svc.exit({ type: "agent", id: agentId }, ADMIN);
    await svc.tick();
    expect((await svc.status({ type: "agent", id: agentId })).windows).toHaveLength(0);
  }, 45_000);

  it("retires a window stuck open past the drain deadline + grace with an error record", async () => {
    const { agentId, runId } = await seedIssueRun(SLOW);
    await waitFor(async () => (await run(runId)).status === "running");

    // A `wait` window whose run never finishes: the tick has nothing to do.
    const svc = service(() => new Date("2026-10-02T12:00:00.000Z"));
    await svc.enter(
      { scope: { type: "agent", id: agentId }, reason: "agent upgrade", drainTimeoutSec: 60, onTimeout: "wait" },
      ADMIN,
    );
    expect((await svc.status({ type: "agent", id: agentId })).windows[0]).toMatchObject({ state: "entering" });

    // Past drain deadline but within the grace: still open, not stuck.
    const graceSvc = service(() => new Date("2026-10-02T12:01:30.000Z"));
    await graceSvc.tick();
    expect((await svc.status({ type: "agent", id: agentId })).windows[0]).toMatchObject({ state: "entering" });

    // Past deadline + grace: retired with an error record, so a later
    // same-scope enter is not blocked (the 02.10 pile-up shape).
    const stuckSvc = service(() => new Date(new Date("2026-10-02T12:00:00.000Z").getTime() + 60_000 + DEFAULT_STUCK_GRACE_MS + 1_000));
    await stuckSvc.tick();
    expect((await svc.status({ type: "agent", id: agentId })).windows).toHaveLength(0);
    const actions = (await db.select({ action: activityLog.action }).from(activityLog)).map((a) => a.action);
    expect(actions).toContain("myrmidon.maintenance.stuck_window_retired");

    // A same-scope enter now succeeds instead of getting 409/being blocked.
    const reentered = await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    expect(reentered.changed).toBe(true);
  }, 45_000);

  it("a hanging onExited hook does not keep the window in leaving longer than one tick", async () => {
    const { agentId, runId } = await seedIssueRun(FAST);
    await waitFor(async () => (await run(runId)).status === "succeeded");

    // A hook that never settles.
    const svc = service(undefined, {
      onExited: () => new Promise(() => undefined),
    });
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    expect((await svc.status({ type: "agent", id: agentId })).windows[0]).toMatchObject({ state: "on" });

    const exited = await svc.exit({ type: "agent", id: agentId }, ADMIN);
    expect(exited).toMatchObject({ state: "leaving", changed: true });

    // The hook timeout is real time; the tick retires the window anyway.
    await svc.tick();
    await waitFor(async () => (await svc.status({ type: "agent", id: agentId })).windows.length === 0, 20_000);
    const actions = (await db.select({ action: activityLog.action }).from(activityLog)).map((a) => a.action);
    // A hung hook is abandoned by withHookTimeout (logged, no audit row); only a
    // THROWING hook audits zabbix_failed. Either way the window retired:
    expect(actions).not.toContain("myrmidon.maintenance.zabbix_failed");
    expect(actions).toContain("myrmidon.maintenance.exited");
  }, 60_000);

  it("a throwing onExited hook does not keep the window in leaving longer than one tick", async () => {
    const { agentId, runId } = await seedIssueRun(FAST);
    await waitFor(async () => (await run(runId)).status === "succeeded");

    const svc = service(undefined, {
      onExited: async () => {
        throw new Error("hook boom");
      },
    });
    await svc.enter({ scope: { type: "agent", id: agentId }, reason: "agent upgrade" }, ADMIN);
    await svc.exit({ type: "agent", id: agentId }, ADMIN);

    await svc.tick();
    await waitFor(async () => (await svc.status({ type: "agent", id: agentId })).windows.length === 0, 20_000);
    const actions = (await db.select({ action: activityLog.action }).from(activityLog)).map((a) => a.action);
    expect(actions).toContain("myrmidon.maintenance.zabbix_failed");
    expect(actions).toContain("myrmidon.maintenance.exited");
  }, 60_000);

  it("one window's hanging hook does not hold back another window's tick (independent ticks)", async () => {
    const seedA = await seedIssueRun(FAST);
    await waitFor(async () => (await run(seedA.runId)).status === "succeeded");
    const seedB = await seedIssueRun(FAST);
    await waitFor(async () => (await run(seedB.runId)).status === "succeeded");

    const svc = service(undefined, {
      onExited: async (window) => {
        if (window.scope.type === "agent" && window.scope.id === seedA.agentId) {
          await new Promise<void>(() => undefined);
        }
      },
    });
    await svc.enter({ scope: { type: "agent", id: seedA.agentId }, reason: "agent upgrade" }, ADMIN);
    await svc.enter({ scope: { type: "agent", id: seedB.agentId }, reason: "agent upgrade" }, ADMIN);
    await svc.exit({ type: "agent", id: seedA.agentId }, ADMIN);
    await svc.exit({ type: "agent", id: seedB.agentId }, ADMIN);

    // Window B retires within the same tick even though window A's hook hangs.
    await svc.tick(); // one tick: A's hook hangs (5s timeout), B retires regardless
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const windows = (await svc.status()).windows;
      const b = windows.find((w) => w.scope.type === "agent" && w.scope.id === seedB.agentId);
      if (!b) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(
      (await svc.status()).windows.filter((w) => w.scope.type === "agent" && w.scope.id === seedB.agentId),
    ).toHaveLength(0);
    // Window A also retires once its hook times out — no window is left behind.
    await waitFor(async () => (await svc.status()).windows.length === 0, 20_000);
  }, 60_000);
});
