import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRunQueuedBusListener,
  createRunStartDispatcher,
  queuedResweepArmDecision,
  RUN_QUEUED_CHANNEL,
  buildRunQueuedPayload,
  resetNoBusLogForTests,
  type RunQueuedBus,
  type RunQueuedPayload,
} from "../myrmidon/run-dispatch/index.ts";

// myrmidon(1.6.6 RUN-DISPATCH-NOTIFY, OPE-6444): the pure half of part B of
// T1.4 — the role gate of the dispatcher's notify branch, the worker-side
// listener of the `run_queued` bus channel, and the role gate of the resweep
// arming rule. The two-process pass against one database lives in
// run-dispatch-notify-two-process.myrmidon.test.ts.

type Handler = (payload: unknown) => void;

beforeEach(() => resetNoBusLogForTests());

function fakeBus() {
  const handlers = new Set<Handler>();
  const published: Array<{ channel: string; payload: RunQueuedPayload }> = [];
  const reconnectHandlers = new Set<() => void>();
  const bus: RunQueuedBus & {
    deliver: (payload: unknown) => void;
    reconnect: () => void;
    subscribeCount: () => number;
  } = {
    publish: async (channel, payload) => {
      published.push({ channel, payload });
    },
    subscribe: (channel, handler) => {
      expect(channel).toBe(RUN_QUEUED_CHANNEL);
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onReconnect: (handler) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    deliver: (payload) => {
      for (const handler of [...handlers]) handler(payload);
    },
    reconnect: () => {
      for (const handler of [...reconnectHandlers]) handler();
    },
    subscribeCount: () => handlers.size,
  };
  return { bus, published };
}

describe("notify mode: the role gate of the dispatcher (part B)", () => {
  it("an api process (executesRuns=false) publishes run_queued instead of starting", async () => {
    const { bus, published } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      executesRuns: () => false,
      requestRemoteStart: (agentId) =>
        bus.publish(RUN_QUEUED_CHANNEL, buildRunQueuedPayload(agentId, "company-1")),
    });

    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(published).toEqual([
      {
        channel: RUN_QUEUED_CHANNEL,
        payload: { agentId: "agent-1", companyId: "company-1", schemaVersion: 1 },
      },
    ]);
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });

  it("the executor (executesRuns=true) starts inline even in notify mode", async () => {
    const { bus, published } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      executesRuns: () => true,
      requestRemoteStart: (agentId) =>
        bus.publish(RUN_QUEUED_CHANNEL, buildRunQueuedPayload(agentId, "company-1")),
    });

    const result = await dispatcher.dispatchRunStart("agent-1");
    expect(result).toEqual([{ id: "run-1" }]);
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
    // The executor publishes too: the listener of the other executors reacts
    // without waiting for its resweep; its own listener message for the same
    // agent is a no-op on the agent start lock.
    expect(published).toEqual([
      {
        channel: RUN_QUEUED_CHANNEL,
        payload: { agentId: "agent-1", companyId: "company-1", schemaVersion: 1 },
      },
    ]);
  });

  it("an api process in inline mode publishes run_queued instead of starting locally — inline is a mode, but api role gate prevents local execution", async () => {
    const { bus, published } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "inline", queuedResweepSec: 30 }),
      executesRuns: () => false,
      requestRemoteStart: (agentId) =>
        bus.publish(RUN_QUEUED_CHANNEL, buildRunQueuedPayload(agentId, "company-1")),
    });

    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(published).toEqual([
      {
        channel: RUN_QUEUED_CHANNEL,
        payload: { agentId: "agent-1", companyId: "company-1", schemaVersion: 1 },
      },
    ]);
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });

  it("notify without a bus on an api process logs and returns — the resweep carries it", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    const info = vi.fn();
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      executesRuns: () => false,
      log: { info },
    });

    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("notify with a bus but no role context publishes, exactly as part A tested", async () => {
    // The part-A shape stays intact: with no `executesRuns` injected the
    // dispatcher keeps the reserved part-A shape — notify publishes and never
    // starts locally. The executor gate is injected only where the role split
    // is wired (heartbeatService options).
    const { bus, published } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      requestRemoteStart: (agentId) =>
        bus.publish(RUN_QUEUED_CHANNEL, buildRunQueuedPayload(agentId, "company-1")),
    });

    expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([]);
    expect(published).toHaveLength(1);
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
  });
});

describe("notify mode: the worker listener of run_queued (part B)", () => {
  it("a run_queued message starts the next queued run of the agent", async () => {
    const { bus } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent,
      sweepQueuedWithoutRunning: async () => ({ agents: 0, started: 0, failed: 0 }),
    });
    listener.start();

    bus.deliver(buildRunQueuedPayload("agent-7", "company-1"));
    await vi.waitFor(() => expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1));
    expect(startNextQueuedRunForAgent).toHaveBeenCalledWith("agent-7");
    listener.stop();
  });

  it("ignores a malformed payload and keeps the subscription", async () => {
    const { bus } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    const warn = vi.fn();
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent,
      sweepQueuedWithoutRunning: async () => ({ agents: 0, started: 0, failed: 0 }),
      log: { warn },
    });
    listener.start();

    bus.deliver({ companyId: "company-1" });
    bus.deliver(buildRunQueuedPayload("agent-8", "company-1"));
    await vi.waitFor(() => expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledTimes(1);
    listener.stop();
  });

  it("a burst of messages for one agent folds into a single start attempt", async () => {
    const { bus } = fakeBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startNextQueuedRunForAgent = vi.fn(async () => {
      await gate;
      return [{ id: "run-1" }];
    });
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent,
      sweepQueuedWithoutRunning: async () => ({ agents: 0, started: 0, failed: 0 }),
    });
    listener.start();

    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    release();
    await vi.waitFor(() => expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1));
    listener.stop();
  });

  it("a bus (re-)listen runs the resweep dogon — the lost-NOTIFY catch-up", async () => {
    const { bus } = fakeBus();
    const sweepQueuedWithoutRunning = vi.fn(async () => ({ agents: 1, started: 1, failed: 0 }));
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent: vi.fn(async () => []),
      sweepQueuedWithoutRunning,
    });
    listener.start();

    bus.reconnect();
    await vi.waitFor(() => expect(sweepQueuedWithoutRunning).toHaveBeenCalledTimes(1));
    listener.stop();
  });

  it("a failing start is logged and does not tear down the subscription", async () => {
    const { bus } = fakeBus();
    const error = vi.fn();
    const startNextQueuedRunForAgent = vi
      .fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue([]);
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent,
      sweepQueuedWithoutRunning: async () => ({ agents: 0, started: 0, failed: 0 }),
      log: { error },
    });
    listener.start();

    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    await vi.waitFor(() => expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(2));
    listener.stop();
  });

  it("stop unsubscribes from the channel and the reconnect dogon", async () => {
    const { bus } = fakeBus();
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    const sweepQueuedWithoutRunning = vi.fn(async () => ({ agents: 0, started: 0, failed: 0 }));
    const listener = createRunQueuedBusListener(bus, {
      startNextQueuedRunForAgent,
      sweepQueuedWithoutRunning,
    });
    listener.start();
    expect(bus.subscribeCount()).toBe(1);
    listener.stop();
    expect(bus.subscribeCount()).toBe(0);

    bus.deliver(buildRunQueuedPayload("agent-1", "company-1"));
    bus.reconnect();
    expect(startNextQueuedRunForAgent).not.toHaveBeenCalled();
    expect(sweepQueuedWithoutRunning).not.toHaveBeenCalled();
  });
});

describe("the role gate of the resweep arming rule (part B)", () => {
  it("an api process never arms the resweep", () => {
    expect(queuedResweepArmDecision({}, { runsBackground: false })).toEqual({
      armed: false,
      reason: "process_role",
    });
  });

  it("the executor arms the resweep exactly as in part A", () => {
    expect(queuedResweepArmDecision({}, { runsBackground: true })).toEqual({
      armed: true,
      reason: null,
    });
    expect(queuedResweepArmDecision({ VITEST: "true" }, { runsBackground: true })).toEqual({
      armed: false,
      reason: "test_runner",
    });
    expect(
      queuedResweepArmDecision({ MYRMIDON_QUEUED_RESWEEP: "0" }, { runsBackground: true }),
    ).toEqual({ armed: false, reason: "disabled_by_env" });
  });

  it("without the role context the decision is the part-A rule, unchanged", () => {
    expect(queuedResweepArmDecision({})).toEqual({ armed: true, reason: null });
  });
});

describe("the run_queued payload contract (part B)", () => {
  it("is the frozen T1.3 shape", () => {
    expect(buildRunQueuedPayload("agent-1", "company-1")).toEqual({
      agentId: "agent-1",
      companyId: "company-1",
      schemaVersion: 1,
    });
    expect(RUN_QUEUED_CHANNEL).toBe("run_queued");
  });
});

// myrmidon(OPE-13117): the board's worker process builds dispatchers for routes
// and services without `executesRuns`; the heartbeat now passes a closure over
// its own role, and the per-event dispatch skips an agent at its run limit.
describe("notify mode: executor dispatcher without a bus (OPE-13117)", () => {
  it("a dispatcher whose process executes runs starts the run and logs the missing bus at most once per 5 calls", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => [{ id: "run-1" }]);
    const info = vi.fn();
    const debug = vi.fn();
    const roleExecutesRuns = true;
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      executesRuns: () => roleExecutesRuns,
      log: { info, debug },
    });

    for (let i = 0; i < 5; i += 1) {
      expect(await dispatcher.dispatchRunStart("agent-1")).toEqual([{ id: "run-1" }]);
    }
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(5);
    expect(info.mock.calls.length).toBeLessThanOrEqual(1);
    expect(info.mock.calls.length + debug.mock.calls.length).toBe(5);
  });

  it("50 events of an agent at its run limit give at most two start calls", async () => {
    const startNextQueuedRunForAgent = vi.fn(async () => []);
    let atLimit = true;
    const dispatcher = createRunStartDispatcher({
      listQueuedAgents: async () => [],
      startNextQueuedRunForAgent,
      loadSettings: async () => ({ runStartDispatch: "notify", queuedResweepSec: 30 }),
      executesRuns: () => true,
      agentAtRunLimit: async () => atLimit,
    });

    for (let i = 0; i < 50; i += 1) await dispatcher.dispatchRunStartUnlessBusy("agent-1");
    expect(startNextQueuedRunForAgent.mock.calls.length).toBeLessThanOrEqual(2);

    // the run finished: the finish dispatch (plain dispatchRunStart) and the
    // next event both reach the start path again
    atLimit = false;
    await dispatcher.dispatchRunStartUnlessBusy("agent-1");
    expect(startNextQueuedRunForAgent).toHaveBeenCalledTimes(1);
  });

  it("reads the settings at most once per 5 s", async () => {
    vi.useFakeTimers();
    try {
      const loadSettings = vi.fn(async () => ({ runStartDispatch: "notify" as const, queuedResweepSec: 30 }));
      const dispatcher = createRunStartDispatcher({
        listQueuedAgents: async () => [],
        startNextQueuedRunForAgent: async () => [],
        loadSettings,
        executesRuns: () => true,
      });
      for (let i = 0; i < 20; i += 1) await dispatcher.dispatchRunStart("agent-1");
      expect(loadSettings).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_001);
      await dispatcher.dispatchRunStart("agent-1");
      expect(loadSettings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
