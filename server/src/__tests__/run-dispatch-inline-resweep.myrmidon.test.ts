import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunStartDispatcher,
  queuedResweepArmDecision,
  startQueuedResweepTimer,
  type QueuedAgentWithoutRunningRun,
} from "../myrmidon/run-dispatch/index.ts";
import {
  DEFAULT_QUEUED_RESWEEP_SEC,
  resolveRunDispatchSettings,
} from "../myrmidon/run-dispatch/settings.ts";

// myrmidon(1.6.6 RUN-DISPATCH, OPE-6443): the pure half of part A of T1.4 — the
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
    });
    expect(resolveRunDispatchSettings(null)).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
    });
  });

  it("reads the stored mode and interval out of general.processes", () => {
    expect(
      resolveRunDispatchSettings({
        processes: { runStartDispatch: "notify", queuedResweepSec: 45 },
      }),
    ).toEqual({ runStartDispatch: "notify", queuedResweepSec: 45 });
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
    ).toEqual({ runStartDispatch: "inline", queuedResweepSec: 30 });
    expect(resolveRunDispatchSettings({ processes: "inline" })).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
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
    expect(resolveRunDispatchSettings({ processes: { queuedResweepSec: 99_999 } })).toMatchObject({
      queuedResweepSec: 3600,
    });
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
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
    });

    expect(await dispatcher.sweepQueuedWithoutRunning()).toMatchObject({ agents: 1, started: 1 });
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
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