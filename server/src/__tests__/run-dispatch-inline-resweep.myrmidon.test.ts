import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunStartDispatcher,
  queuedResweepArmDecision,
  resolveStaleQueuedRunIssueId,
  startQueuedResweepTimer,
  type QueuedAgentWithoutRunningRun,
} from "../myrmidon/run-dispatch/index.ts";
import { queuedRunWaitingSince } from "../modules/run-dispatch/domain/queued-run-age.ts";
import {
  DEFAULT_QUEUED_RESWEEP_SEC,
  DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
  resolveRunDispatchSettings,
} from "../myrmidon/run-dispatch/settings.ts";

// myrmidon(1.6.6 RUN-DISPATCH, OPE-6977): the pure half of part A of T1.4 — the
// strategy switch of the start dispatcher, the loop of the queued-run resweep and
// the arming rule of its timer. The database-facing half (the "queued without
// running" selection and the real queued -> running lift) lives in
// queued-run-resweep.myrmidon.test.ts.

const queued = (agentId: string, oldestQueuedAt = new Date(0)): QueuedAgentWithoutRunningRun => ({
  agentId,
  oldestQueuedAt,
});

describe("run dispatch settings", () => {
  it("defaults to inline with a 30 s resweep when nothing is stored", () => {
    expect(resolveRunDispatchSettings({})).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: DEFAULT_QUEUED_RESWEEP_SEC,
      queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
    });
    expect(resolveRunDispatchSettings(null)).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
      queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
    });
  });

  it("reads the stored mode and interval out of general.processes", () => {
    expect(
      resolveRunDispatchSettings({
        processes: { runStartDispatch: "notify", queuedResweepSec: 45 },
      }),
    ).toMatchObject({ runStartDispatch: "notify", queuedResweepSec: 45, queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC });
  });

  it("normalizes the mode and accepts a numeric string interval", () => {
    expect(
      resolveRunDispatchSettings({ processes: { runStartDispatch: " NOTIFY " } }),
    ).toMatchObject({ runStartDispatch: "notify" });
    expect(
      resolveRunDispatchSettings({ processes: { queuedResweepSec: "45" } }),
    ).toMatchObject({ queuedResweepSec: 45 });
  });

  it("falls back to the defaults instead of failing on a malformed value", () => {
    expect(
      resolveRunDispatchSettings({
        processes: { runStartDispatch: "sometimes", queuedResweepSec: "soon" },
      }),
    ).toMatchObject({ runStartDispatch: "inline", queuedResweepSec: 30, queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC });
    expect(resolveRunDispatchSettings({ processes: "inline" })).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
      queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
    });
    expect(resolveRunDispatchSettings({ processes: { queuedResweepSec: true } })).toMatchObject({
      queuedResweepSec: 30,
    });
  });

  it("clamps the interval to a usable band", () => {
    expect(resolveRunDispatchSettings({ processes: { queuedResweepSec: 0 } })).toMatchObject({
      queuedResweepSec: 5,
    });
    expect(resolveRunDispatchSettings({ processes: { queuedResweepSec: -30 } })).toMatchObject({
      queuedResweepSec: 5,
    });
    expect(resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: 0 } })).toMatchObject({ queuedRunStaleAfterSec: 300 });
    expect(resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: 999999 } })).toMatchObject({ queuedRunStaleAfterSec: 604800 });
    expect(resolveRunDispatchSettings({ processes: { queuedResweepSec: 99_999 } })).toMatchObject({
      queuedResweepSec: 3600,
    });
  });
});

// myrmidon(OPE-11947): the age of a queued run for the stale-queued sweep. A
// scheduled retry is created at the failure and promoted to `queued` when its
// `scheduled_retry_at` falls due, so it waits since that time, not since
// `created_at`. The database twin (the sweep's SQL selection and the guard in
// cancelStaleQueuedRun) is covered in modules/run-dispatch/adapters/postgres.myrmidon.test.ts.
describe("queued run waiting-since (OPE-11947)", () => {
  const now = new Date("2026-11-06T15:00:00.000Z");
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const staleAfterMs = 30 * 60_000;
  const isStale = (run: { createdAt: Date; scheduledRetryAt?: Date | string | null }) =>
    now.getTime() - queuedRunWaitingSince(run, now).getTime() >= staleAfterMs;

  it("counts an ordinary queued run from created_at: 40 minutes old is stale", () => {
    const run = { createdAt: minutesAgo(40), scheduledRetryAt: null };
    expect(queuedRunWaitingSince(run, now)).toEqual(run.createdAt);
    expect(isStale(run)).toBe(true);
    expect(isStale({ createdAt: minutesAgo(40) })).toBe(true);
  });

  it("counts a promoted scheduled retry from its due time: created 40 minutes ago, due 1 minute ago is fresh", () => {
    const run = { createdAt: minutesAgo(40), scheduledRetryAt: minutesAgo(1) };
    expect(queuedRunWaitingSince(run, now)).toEqual(run.scheduledRetryAt);
    expect(isStale(run)).toBe(false);
  });

  it("keeps a long-delay retry (created 6 h ago) fresh right after it fell due", () => {
    expect(isStale({ createdAt: minutesAgo(6 * 60 + 1), scheduledRetryAt: minutesAgo(1) })).toBe(false);
  });

  it("declares a promoted retry stale once it stood in the queue past the threshold since it fell due", () => {
    expect(isStale({ createdAt: minutesAgo(90), scheduledRetryAt: minutesAgo(31) })).toBe(true);
    expect(isStale({ createdAt: minutesAgo(90), scheduledRetryAt: minutesAgo(29) })).toBe(false);
  });

  it("accepts the due time as an ISO string", () => {
    expect(isStale({ createdAt: minutesAgo(40), scheduledRetryAt: minutesAgo(1).toISOString() })).toBe(false);
  });

  it("ignores a due time that is still in the future and an unreadable one: created_at decides", () => {
    expect(isStale({ createdAt: minutesAgo(40), scheduledRetryAt: new Date(now.getTime() + 5 * 60_000) })).toBe(true);
    expect(isStale({ createdAt: minutesAgo(40), scheduledRetryAt: "not a date" })).toBe(true);
  });
});

describe("run start dispatcher", () => {
  it("inline (the default) is the vendor start path, unchanged", async () => {
    const started = [{ id: "run-1" }];
    const startNextQueuedRunForAgent = vi.fn(async () => started);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
    });

    expect(await dispatcher.mode()).toBe("inline");
    const result = await dispatcher.dispatchRunStart("agent-1", { otherAgentsWaiting: true });

    expect(result).toBe(started);
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
    expect(startNextQueuedRunForAgent).toHaveBeenCalledWith("agent-1", {
      otherAgentsWaiting: true,
    });
  });

  it("notify without a process bus starts nothing on this process", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const info = vi.fn();
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      log: { info },
    });

    expect(await dispatcher.mode()).toBe("notify");
    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("notify with a bus hook publishes the request instead of starting", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const requestRemoteStart = vi.fn(async () => {});
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      requestRemoteStart,
    });

    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(requestRemoteStart).toHaveBeenCalledWith("agent-1");
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });
});

describe("queued resweep pass", () => {
  it("starts every agent that has a queued run and no running run, once per pass", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run" }]);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1"), queued("agent-2")],
      startNextQueuedRunForAgent,
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toEqual({
      agents: 2,
      started: 2,
      failed: 0,
    });
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(2);
    expect(startNextQueuedRunForAgent.mock.calls.map(([agentId]) => agentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    // More than one agent is waiting: the vendor fair-share hint is set.
    for (const [, options] of startNextQueuedRunForAgent.mock.calls) {
      expect(options).toEqual({ otherAgentsWaiting: true });
    }
  });

  it("starts the local run whatever the dispatch mode says: it is the NOTIFY fallback", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run" }]);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1")],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30, queuedRunStaleAfterSec: 1800 }),
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toMatchObject({ agents: 1, started: 1 });
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
  });

  it("uses the local executor start path when notify resweep recovers a lost NOTIFY", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run" }]);
    const requestRemoteStart = vi.fn(async () => {});
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1")],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30, queuedRunStaleAfterSec: 1800 }),
      executesRuns: () => true,
      requestRemoteStart,
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toMatchObject({ agents: 1, started: 1 });
    expect(startNextQueuedRunForAgent).toHaveBeenCalledWith("agent-1", {
      otherAgentsWaiting: false,
    });
    expect(requestRemoteStart).not.toHaveBeenCalled();
  });

  it("keeps api resweeps in notify mode remote-only", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run" }]);
    const requestRemoteStart = vi.fn(async () => {});
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1")],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30, queuedRunStaleAfterSec: 1800 }),
      executesRuns: () => false,
      requestRemoteStart,
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toEqual({
      agents: 1,
      started: 0,
      failed: 0,
    });
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(requestRemoteStart).toHaveBeenCalledWith("agent-1");
  });

  it("does not start a run for an agent that already has one (queued without running)", async () => {
    // After the first pass the run is no longer queued, so the selection of the
    // second pass is empty — nothing is started twice.
    const seen: string[] = [];
    let pass = 0;
    const startNextQueuedRunForAgent = vi.fn(async (agentId: string) => {
      seen.push(agentId);
      pass += 1;
      return [{ id: "run" }];
    });
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => (pass === 0 ? [queued("agent-1")] : []),
      startNextQueuedRunForAgent,
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toMatchObject({ agents: 1, started: 1 });
    expect(await dispatcher.sweepQueuedWithoutRunning()).toEqual({
      agents: 0,
      started: 0,
      failed: 0,
    });
    expect(seen).toEqual(["agent-1"]);
  });

  it("reports a start that returns nothing as selected but not started", async () => {
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1")],
      startNextQueuedRunForAgent: async () => [],
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toEqual({
      agents: 1,
      started: 0,
      failed: 0,
    });
  });

  it("keeps the pass going when one agent throws", async () => {
    const error = vi.fn();
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [queued("agent-1"), queued("agent-2")],
      startNextQueuedRunForAgent: async (agentId) => {
        if (agentId === "agent-1") throw new Error("boom");
        return [{ id: "run" }];
      },
      log: { error },
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toEqual({
      agents: 2,
      started: 1,
      failed: 1,
    });
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("cancels stale queued runs and wakes the associated agent before resweeping", async () => {
    const staleRun = { id: "run-stale", agentId: "agent-stale", companyId: "company-1", createdAt: new Date(0) };
    const listStaleQueuedRuns = vi.fn(async () => [staleRun]);
    const createCancelStaleQueuedRun = vi.fn(async () => true);
    const wakeAgent = vi.fn(async () => {});
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30, queuedRunStaleAfterSec: 120 }),
      listStaleQueuedRuns,
      createCancelStaleQueuedRun,
      wakeAgent,
    });

    await dispatcher.sweepQueuedWithoutRunning();

    expect(listStaleQueuedRuns).toHaveBeenCalledWith({ executionCutoff: null, staleAfterMs: 120_000 });
    expect(createCancelStaleQueuedRun).toHaveBeenCalledWith(staleRun, 120_000);
    // The cancelled run stood on no task: the wake carries none either.
    expect(wakeAgent).toHaveBeenCalledWith("agent-stale", "company-1", { issueId: null });
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });

  it("hands the cancelled run's task to the wake so the agent resumes it", async () => {
    // myrmidon(OPE-11947): the wake used to carry a made-up `system:` task id.
    const issueId = "5b3f8a52-6f0c-4f6b-9d21-0c1f5a3e7a10";
    const staleRun = { id: "run-stale", agentId: "agent-stale", companyId: "company-1", createdAt: new Date(0), issueId };
    const wakeAgent = vi.fn(async () => {});
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent: async () => [],
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30, queuedRunStaleAfterSec: 120 }),
      listStaleQueuedRuns: async () => [staleRun],
      createCancelStaleQueuedRun: async () => true,
      wakeAgent,
    });

    await dispatcher.sweepQueuedWithoutRunning();

    expect(wakeAgent).toHaveBeenCalledWith("agent-stale", "company-1", { issueId });
  });

  it("does not wake the agent when the stale cancellation lost the race", async () => {
    const wakeAgent = vi.fn(async () => {});
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent: async () => [],
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30, queuedRunStaleAfterSec: 120 }),
      listStaleQueuedRuns: async () => [
        { id: "run-stale", agentId: "agent-stale", companyId: "company-1", createdAt: new Date(0), issueId: "5b3f8a52-6f0c-4f6b-9d21-0c1f5a3e7a10" },
      ],
      createCancelStaleQueuedRun: async () => false,
      wakeAgent,
    });

    await dispatcher.sweepQueuedWithoutRunning();

    expect(wakeAgent).not.toHaveBeenCalled();
  });

  it("continues cleanup after a stale cancellation fails", async () => {
    const error = vi.fn();
    const wakeAgent = vi.fn(async () => {});
    const runs = [
      { id: "run-1", agentId: "agent-1", companyId: "company-1", createdAt: new Date(0) },
      { id: "run-2", agentId: "agent-2", companyId: "company-1", createdAt: new Date(0) },
    ];
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent: async () => [],
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30, queuedRunStaleAfterSec: 1800 }),
      listStaleQueuedRuns: async () => runs,
      createCancelStaleQueuedRun: async (run) => {
        if (run.id === "run-1") throw new Error("cancel failed");
        return true;
      },
      wakeAgent,
      log: { error },
    });

    await dispatcher.sweepQueuedWithoutRunning();

    expect(error).toHaveBeenCalledTimes(1);
    expect(wakeAgent).toHaveBeenCalledWith("agent-2", "company-1", { issueId: null });
  });

  it("passes the worktree execution cutoff to the selection", async () => {
    const cutoff = new Date("2026-10-08T00:00:00.000Z");
    const listQueuedAgents = vi.fn(async () => []);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents,
      startNextQueuedRunForAgent: async () => [],
      readCutoff: async () => cutoff,
    });

    await dispatcher.sweepQueuedWithoutRunning();

    expect(listQueuedAgents).toHaveBeenCalledWith({ cutoff });
  });
});

describe("stale queued run task resolution", () => {
  const issueId = "5b3f8a52-6f0c-4f6b-9d21-0c1f5a3e7a10";

  it("reads the cancelled run's task from its context, then the denormalized columns", () => {
    const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: { issueId } })).toBe(issueId);
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: {}, contextIssueId: issueId })).toBe(issueId);
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: null, nativeIssueId: issueId })).toBe(issueId);
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: { taskId: issueId } })).toBe(issueId);
    expect(
      resolveStaleQueuedRunIssueId({ contextSnapshot: { issueId }, contextIssueId: other, nativeIssueId: other }),
    ).toBe(issueId);
  });

  it("skips values that are not issue UUIDs", () => {
    expect(resolveStaleQueuedRunIssueId({})).toBeNull();
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: { taskId: "system:queued-run-stale-timeout" } })).toBeNull();
    expect(resolveStaleQueuedRunIssueId({ contextSnapshot: { issueId: 42 }, contextIssueId: "OPE-1" })).toBeNull();
    expect(
      resolveStaleQueuedRunIssueId({ contextSnapshot: { issueId: "system:x" }, nativeIssueId: issueId }),
    ).toBe(issueId);
  });
});

describe("periodic queued resweep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the stored interval, then re-reads it every cycle", async () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => ({ agents: 0, started: 0, failed: 0 }));
    let intervalSec = 45;
    const onCycle = vi.fn();
    const stop = startQueuedResweepTimer({
      sweep,
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: intervalSec }),
      onCycle,
    });

    // The arming microtask runs first: the stored interval applies from the first wait.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(sweep).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(onCycle).toHaveBeenCalledWith({
      intervalSec: 45,
      outcome: { agents: 0, started: 0, failed: 0 },
    });

    // A saved interval takes effect on the next wait, without a restart.
    intervalSec = 10;
    await vi.advanceTimersByTimeAsync(44_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    stop();
  });

  it("stops on the stop function and survives a failing pass", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const sweep = vi.fn(async () => {
      throw new Error("sweep failed");
    });
    const stop = startQueuedResweepTimer({
      sweep,
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30 }),
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe("resweep arming", () => {
  it("arms with a clean production environment", () => {
    expect(queuedResweepArmDecision({})).toEqual({ armed: true, reason: null });
    expect(queuedResweepArmDecision({ NODE_ENV: "production" })).toEqual({
      armed: true,
      reason: null,
    });
  });

  it("stays off under a test runner, whatever the kill switch says", () => {
    expect(queuedResweepArmDecision({ NODE_ENV: "test" })).toEqual({
      armed: false,
      reason: "test_runner",
    });
    expect(queuedResweepArmDecision({ VITEST: "true" })).toEqual({
      armed: false,
      reason: "test_runner",
    });
  });

  it("honours the kill switch", () => {
    for (const value of ["0", "off", "false", "no", " OFF "]) {
      expect(queuedResweepArmDecision({ MYRMIDON_QUEUED_RESWEEP: value })).toEqual({
        armed: false,
        reason: "disabled_by_env",
      });
    }
    expect(queuedResweepArmDecision({ MYRMIDON_QUEUED_RESWEEP: "1" })).toEqual({
      armed: true,
      reason: null,
    });
  });
});