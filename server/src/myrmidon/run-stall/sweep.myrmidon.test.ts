import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { resolveTeamLivenessSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { RUN_STALL_ERROR_CODE } from "./constants.js";
import { classifyRunStall, progressSilenceMs } from "./policy.js";
import { createRunStallSweep, readRunProgress, type RunStallSweepDeps } from "./sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MINUTE = 60 * 1000;
const THRESHOLD_SEC = 20 * 60;

describeEmbeddedPostgres("run stall sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-run-stall-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One running run on an assigned in-progress task, with its recorded progress
   * placed `staleMinutes` in the past. `freshEventMinutes` adds one run event
   * that new (the "quiet but alive" case).
   */
  async function seed(input: {
    staleMinutes: number;
    runStatus?: string;
    issueStatus?: string;
    executionState?: Record<string, unknown> | null;
    freshEventMinutes?: number;
    identifier?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const identifier = input.identifier ?? `RS${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: identifier.slice(0, 8),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      title: "Task a",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionState: input.executionState ?? null,
    });
    const staleAt = new Date(Date.now() - input.staleMinutes * MINUTE);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId,
        agentId,
        status: input.runStatus ?? "running",
        contextSnapshot: { issueId },
        startedAt: staleAt,
        processStartedAt: staleAt,
        lastOutputAt: staleAt,
      })
      .returning();
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: run!.id,
      agentId,
      seq: 1,
      eventType: "lifecycle",
      createdAt: staleAt,
      message: "run started",
    });
    if (input.freshEventMinutes !== undefined) {
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId: run!.id,
        agentId,
        seq: 2,
        eventType: "output",
        createdAt: new Date(Date.now() - input.freshEventMinutes * MINUTE),
        message: "still working",
      });
    }
    return { companyId, agentId, issueId, runId: run!.id, identifier };
  }

  function deps(overrides: Partial<RunStallSweepDeps> = {}): RunStallSweepDeps {
    return {
      db,
      env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: String(THRESHOLD_SEC) } as NodeJS.ProcessEnv,
      interruptRun: vi.fn(async ({ runId }: { runId: string }) => {
        // Mirrors the real cancel path: the run ends, so a later pass finds no
        // candidate. That is what makes the sweep idempotent without a key.
        await db
          .update(heartbeatRuns)
          .set({ status: "cancelled", errorCode: RUN_STALL_ERROR_CODE, finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, runId));
      }),
      returnIssueToTodo: vi.fn(async ({ issueId }: { issueId: string }) => {
        await db.update(issues).set({ status: "todo", executionState: null }).where(eq(issues.id, issueId));
        return true;
      }),
      wakeAssignee: vi.fn(async ({ agentId, issueId, runId }: { agentId: string; issueId: string; runId: string }) => {
        const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
        await db.insert(agentWakeupRequests).values({
          companyId: agent!.companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "run_stalled",
          status: "queued",
          payload: { issueId },
          idempotencyKey: `run_stall:${runId}`,
        });
        return true;
      }),
      isRunUnderMaintenance: vi.fn(async () => false),
      logActivity: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  function sweepWith(overrides: Partial<RunStallSweepDeps> = {}) {
    const injected = deps(overrides);
    // Every pass is the first pass: the module's own interval throttle is
    // exercised by its own test below.
    return { injected, sweep: createRunStallSweep(injected) };
  }

  it("interrupts a run whose recorded progress went stale, re-opens the task and wakes the assignee", async () => {
    const seeded = await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith();

    const result = await sweep.sweep();

    expect(result).toMatchObject({ scanned: 1, interrupted: 1, returnedToTodo: 1, woken: 1, skippedActive: 0 });
    expect(injected.interruptRun).toHaveBeenCalledTimes(1);
    expect(injected.interruptRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: seeded.runId, companyId: seeded.companyId, issueId: seeded.issueId }),
    );
    const silence = (injected.interruptRun as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { silenceMs: number };
    expect(silence.silenceMs).toBeGreaterThanOrEqual(45 * MINUTE);

    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue).toMatchObject({ status: "todo", executionState: null });

    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, seeded.agentId), eq(agentWakeupRequests.status, "queued")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.payload).toMatchObject({ issueId: seeded.issueId });

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: RUN_STALL_ERROR_CODE });

    expect(injected.logActivity).toHaveBeenCalledTimes(1);
    expect((injected.logActivity as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      companyId: seeded.companyId,
      runId: seeded.runId,
      actorType: "system",
      action: "myrmidon.run_stall.interrupted",
    });
  });

  it("leaves a run alone while it keeps recording events", async () => {
    const seeded = await seed({ staleMinutes: 45, freshEventMinutes: 2 });
    const { injected, sweep } = sweepWith();

    const result = await sweep.sweep();

    // The newest event is inside the threshold, so the run is not even a
    // candidate of the scan.
    expect(result).toMatchObject({ scanned: 0, interrupted: 0, woken: 0 });
    expect(injected.interruptRun).not.toHaveBeenCalled();
    expect(injected.wakeAssignee).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run!.status).toBe("running");
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_progress");
  });

  it("reads a fresh run event as progress even when the output columns are old", async () => {
    // The re-read the sweep does right before it acts reads the newest appended
    // event as well; that is what makes progress landing between the scan and
    // the interrupt keep the run alive.
    const seeded = await seed({ staleMinutes: 45, freshEventMinutes: 2 });
    const progress = await readRunProgress(db, seeded.runId);
    expect(progress).not.toBeNull();
    const silenceMs = progressSilenceMs(progress!, new Date());
    expect(silenceMs).not.toBeNull();
    expect(silenceMs!).toBeLessThan(5 * MINUTE);
    expect(classifyRunStall({ run: progress!, now: new Date(), thresholdMs: THRESHOLD_SEC * 1000 })).toBe("active");
  });

  it("skips a run whose progress landed between the scan and the interrupt", async () => {
    const seeded = await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith({
      // The maintenance gate runs between the scan and the confirming re-read;
      // writing fresh progress here is exactly the window this test proves.
      isRunUnderMaintenance: vi.fn(async () => {
        await db
          .update(heartbeatRuns)
          .set({ lastOutputAt: new Date() })
          .where(eq(heartbeatRuns.id, seeded.runId));
        return false;
      }),
    });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, interrupted: 0, skippedActive: 1 });
    expect(injected.interruptRun).not.toHaveBeenCalled();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
    expect(run!.status).toBe("running");
  });

  it("leaves a run alone whose recorded progress is inside the threshold", async () => {
    await seed({ staleMinutes: 5 });
    const { injected, sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 0, interrupted: 0 });
    expect(injected.interruptRun).not.toHaveBeenCalled();
  });

  it("never touches a run in a maintenance window", async () => {
    await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith({ isRunUnderMaintenance: vi.fn(async () => true) });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, interrupted: 0, skippedMaintenance: 1 });
    expect(injected.interruptRun).not.toHaveBeenCalled();
    expect(injected.returnIssueToTodo).not.toHaveBeenCalled();
  });

  it("is idempotent: a second pass after the interrupt finds nothing to do", async () => {
    const seeded = await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith();
    await sweep.sweep();
    sweep.resetForTest();
    const second = await sweep.sweep({ force: true });
    expect(second).toMatchObject({ scanned: 0, interrupted: 0, woken: 0 });
    expect(injected.interruptRun).toHaveBeenCalledTimes(1);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.agentId));
    expect(wakes).toHaveLength(1);
  });

  it("shares one in-flight pass instead of stacking a second scan", async () => {
    await seed({ staleMinutes: 45 });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { injected, sweep } = sweepWith({
      interruptRun: vi.fn(async ({ runId }: { runId: string }) => {
        await gate;
        await db
          .update(heartbeatRuns)
          .set({ status: "cancelled", errorCode: RUN_STALL_ERROR_CODE })
          .where(eq(heartbeatRuns.id, runId));
      }),
    });
    const first = sweep.sweep();
    const second = sweep.sweep();
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(injected.interruptRun).toHaveBeenCalledTimes(1);
  });

  it("rate-limits the scan between passes", async () => {
    await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith();
    await sweep.sweep();
    const throttled = await sweep.sweep();
    expect(throttled).toMatchObject({ scanned: 0, interrupted: 0 });
    expect(injected.interruptRun).toHaveBeenCalledTimes(1);
  });

  it("caps the runs inspected in one pass and handles the stalest first", async () => {
    const older = await seed({ staleMinutes: 90, identifier: "RSAAA001" });
    await seed({ staleMinutes: 30, identifier: "RSAAA002" });
    const { injected, sweep } = sweepWith({
      env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: String(THRESHOLD_SEC), MYRMIDON_RUN_STALL_PAGE_SIZE: "1" } as NodeJS.ProcessEnv,
    });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 1, interrupted: 1 });
    expect((injected.interruptRun as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ runId: older.runId });
  });

  it("does nothing at all when the feature is switched off", async () => {
    await seed({ staleMinutes: 45 });
    const { injected, sweep } = sweepWith({
      env: { MYRMIDON_RUN_STALL_ENABLED: "0", MYRMIDON_RUN_STALL_THRESHOLD_SEC: String(THRESHOLD_SEC) } as NodeJS.ProcessEnv,
    });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 0, interrupted: 0 });
    expect(injected.interruptRun).not.toHaveBeenCalled();
  });

  it("keeps a mid-flight workflow status: an in-review task is not forced to todo", async () => {
    const seeded = await seed({ staleMinutes: 45, issueStatus: "in_review" });
    const { injected, sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ interrupted: 1, returnedToTodo: 0 });
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(issue!.status).toBe("in_review");
    expect(injected.wakeAssignee).toHaveBeenCalledTimes(1);
  });

  it("does not queue a second wake when one already covers the task", async () => {
    const seeded = await seed({ staleMinutes: 45 });
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      source: "automation",
      reason: "comment",
      status: "queued",
      payload: { issueId: seeded.issueId },
    });
    const { injected, sweep } = sweepWith();
    const result = await sweep.sweep();
    expect(result).toMatchObject({ interrupted: 1, woken: 0 });
    expect(injected.wakeAssignee).not.toHaveBeenCalled();
  });

  it("reports a failed interrupt without aborting the rest of the pass", async () => {
    const failing = await seed({ staleMinutes: 90, identifier: "RSBBB001" });
    const good = await seed({ staleMinutes: 60, identifier: "RSBBB002" });
    const { injected, sweep } = sweepWith({
      interruptRun: vi.fn(async ({ runId }: { runId: string }) => {
        if (runId === failing.runId) throw new Error("adapter stop failed");
        await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
      }),
    });
    const result = await sweep.sweep();
    expect(result).toMatchObject({ scanned: 2, interrupted: 1, failed: 1 });
    expect(result.runIds).toEqual([good.runId]);
    expect(injected.returnIssueToTodo).toHaveBeenCalledTimes(1);
  });

  /**
   * myrmidon(RUN-STALL-SETTINGS, 1.6.5): the switch and the silence threshold
   * live in `instance_settings.general.teamLiveness` and reach every pass
   * through the reader production wires (`resolveTeamLivenessSettings({ stored,
   * env })` over the stored row). These cases drive that reader over a row the
   * test mutates between passes, with one sweep instance alive the whole time —
   * the "no restart" half of what the settings page sells. Without the live
   * read the first case fails (an off switch would still interrupt) and without
   * the per-pass read the second one does (turning it back on would do nothing).
   */
  describe("myrmidon(RUN-STALL-SETTINGS): the panel switch decides every pass", () => {
    const ENV = { MYRMIDON_RUN_STALL_THRESHOLD_SEC: String(THRESHOLD_SEC) } as NodeJS.ProcessEnv;

    /** The live sweep plus the stored row its reader resolves on every pass. */
    function sweepOverStoredRow(initial: Record<string, unknown>) {
      const row: { stored: unknown } = { stored: initial };
      const injected = deps({
        env: ENV,
        readLiveness: async () => resolveTeamLivenessSettings({ stored: row.stored, env: ENV }),
      });
      return { row, injected, sweep: createRunStallSweep(injected) };
    }

    it("stops the guard when the switch is off and starts it again when it is on, without a restart", async () => {
      const first = await seed({ staleMinutes: 45, identifier: "RSSW0001" });
      const { row, injected, sweep } = sweepOverStoredRow({ runStallEnabled: false });

      // Off in the panel: a run silent for 45 minutes is left alone.
      const off = await sweep.sweep({ force: true });
      expect(off).toMatchObject({ scanned: 0, interrupted: 0, returnedToTodo: 0, woken: 0 });
      expect(injected.interruptRun).not.toHaveBeenCalled();
      let [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId));
      expect(run!.status).toBe("running");
      const [issue] = await db.select().from(issues).where(eq(issues.id, first.issueId));
      expect(issue!.status).toBe("in_progress");

      // The operator flips it on: the same sweep instance, no restart.
      row.stored = { runStallEnabled: true };
      const on = await sweep.sweep({ force: true });
      expect(on).toMatchObject({ scanned: 1, interrupted: 1, returnedToTodo: 1, woken: 1 });

      // And back off: the very next pass stands the guard down again.
      const second = await seed({ staleMinutes: 45, identifier: "RSSW0002" });
      row.stored = { runStallEnabled: false };
      const offAgain = await sweep.sweep({ force: true });
      expect(offAgain).toMatchObject({ scanned: 0, interrupted: 0, woken: 0 });
      expect(injected.interruptRun).toHaveBeenCalledTimes(1);
      [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, second.runId));
      expect(run!.status).toBe("running");
    });

    it("applies a silence threshold saved in the panel to the very next pass", async () => {
      const seeded = await seed({ staleMinutes: 45 });
      const { row, injected, sweep } = sweepOverStoredRow({
        runStallEnabled: true,
        runStallThresholdSec: 60 * 60,
      });

      // 45 minutes of silence is still inside the hour the operator asked for.
      const waiting = await sweep.sweep({ force: true });
      expect(waiting).toMatchObject({ scanned: 0, interrupted: 0 });
      const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(stillRunning!.status).toBe("running");

      // Lower it to 20 minutes: the same run is overdue on the next pass.
      row.stored = { runStallEnabled: true, runStallThresholdSec: THRESHOLD_SEC };
      const overdue = await sweep.sweep({ force: true });
      expect(overdue).toMatchObject({ scanned: 1, interrupted: 1, woken: 1 });
      expect(injected.interruptRun).toHaveBeenCalledTimes(1);
    });

    it("leaves a run alone whose own agent card switched progress liveness off", async () => {
      const seeded = await seed({ staleMinutes: 45 });
      await db
        .update(agents)
        .set({ adapterConfig: { teamLiveness: { runStall: false } } })
        .where(eq(agents.id, seeded.agentId));
      const { injected, sweep } = sweepOverStoredRow({ runStallEnabled: true });

      // The instance switch is on, but this agent's own card says no: its silent
      // run keeps going until the hard run timeout.
      const result = await sweep.sweep({ force: true });

      expect(result).toMatchObject({ scanned: 1, interrupted: 0, skippedExempt: 1 });
      expect(injected.interruptRun).not.toHaveBeenCalled();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.runId));
      expect(run!.status).toBe("running");
    });
  });
});