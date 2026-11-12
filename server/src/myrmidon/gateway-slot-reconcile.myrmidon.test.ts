import { describe, expect, it } from "vitest";
import {
  GATEWAY_SLOT_PROBE_MEMORY_TTL_MS,
  GATEWAY_SLOT_RECONCILE_INTERVAL_MS,
  OWNED_BOARD_RUN_STATUSES,
  TERMINAL_BOARD_RUN_STATUSES,
  isGatewayRunConfirmedClosed,
  markGatewayRunConfirmedClosed,
  reconcileGatewaySlotsFromRows,
  recordGatewaySlotSweep,
  reconcileGatewaySlotsOnRunStart,
  resetGatewaySlotProbeMemoryForTest,
  resetGatewaySlotReconcileThrottleForTest,
  shouldReconcileGatewaySlotsForAgent,
  type GatewaySlotReconcilePort,
  type ResolvedGatewayCredentials,
} from "./gateway-slot-reconcile.js";

// myrmidon(GATEWAY-SLOT-RECONCILE, OPE-11888): before a gateway agent's next
// run starts, the board probes the gateway run ids it already persisted
// (externalRunId). A gateway run still live for a board-terminal run is a
// leaked max_concurrent_runs slot and is stopped; a run the board still owns
// (queued/running/scheduled_retry) is never stopped — that is the "do not
// abort a live leased run" invariant. The sweep is idempotent (a gateway that
// already forgot the run answers not_found; no stop fires) and fail-open (an
// unreachable gateway changes nothing and never blocks the start).

type ProbeState = "live" | "terminal" | "not_found" | "unreachable";

function makePort(options: {
  probe: (gatewayRunId: string) => ProbeState;
  onStop?: (gatewayRunId: string) => { stopped: boolean } | Promise<{ stopped: boolean }>;
}) {
  const probes: string[] = [];
  const stops: string[] = [];
  const resolveCalls: string[] = [];
  let lastProbeCredentials: ResolvedGatewayCredentials | null = null;
  let lastStopCredentials: ResolvedGatewayCredentials | null = null;
  const port: GatewaySlotReconcilePort = {
    resolveCredentials: async ({ agentId }) => {
      resolveCalls.push(agentId);
      return { baseUrl: "https://gw.example", apiKey: "k" };
    },
    probeGatewayRun: async ({ gatewayRunId, resolvedCredentials }) => {
      probes.push(gatewayRunId);
      lastProbeCredentials = resolvedCredentials ?? null;
      return { state: options.probe(gatewayRunId), status: "running" };
    },
    stopGatewayRunForBoard: async ({ gatewayRunId, resolvedCredentials }) => {
      stops.push(gatewayRunId);
      lastStopCredentials = resolvedCredentials ?? null;
      const outcome = options.onStop
        ? await options.onStop(gatewayRunId)
        : { stopped: true };
      return outcome;
    },
  };
  return {
    port,
    probes,
    stops,
    resolveCalls,
    lastProbeCredentials: () => lastProbeCredentials,
    lastStopCredentials: () => lastStopCredentials,
  };
}

const agent = { id: "agent-1", companyId: "company-1", adapterConfig: {} };

describe("myrmidon(GATEWAY-SLOT-RECONCILE) gateway slot reconcile on run start", () => {
  it("stops a gateway run that is still live for a board-terminal run (the leaked slot)", async () => {
    const { port, probes, stops } = makePort({ probe: () => "live" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [
        { id: "run-old", status: "cancelled", externalRunId: "gw-leaked" },
        { id: "run-new", status: "running", externalRunId: "gw-owned" },
      ],
      port,
      { quiet: true },
    );

    // The board still owns run-new: its gateway run is not even probed.
    expect(probes).toEqual(["gw-leaked"]);
    expect(stops).toEqual(["gw-leaked"]);
    expect(result).toMatchObject({
      scanned: 2,
      probed: 1,
      stopped: 1,
      skippedOwned: 1,
      stoppedRunIds: [{ runId: "run-old", gatewayRunId: "gw-leaked" }],
    });
  });

  it("never stops a run the board still owns — every OWNED status is skipped without probing", async () => {
    const { port, probes, stops } = makePort({ probe: () => "live" });
    const rows = OWNED_BOARD_RUN_STATUSES.map((status, i) => ({
      id: `run-${i}`,
      status,
      externalRunId: `gw-${i}`,
    }));
    const result = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });

    expect(probes).toEqual([]);
    expect(stops).toEqual([]);
    expect(result.stopped).toBe(0);
    expect(result.skippedOwned).toBe(OWNED_BOARD_RUN_STATUSES.length);
  });

  it("is idempotent: after the stop, the gateway reports the run gone and no stop fires again", async () => {
    let gatewayState: ProbeState = "live";
    const { port, stops } = makePort({
      probe: () => gatewayState,
      onStop: () => {
        gatewayState = "not_found";
        return { stopped: true };
      },
    });
    const rows = [{ id: "run-old", status: "timed_out", externalRunId: "gw-leaked" }] as const;

    const first = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(first.stopped).toBe(1);
    expect(stops).toHaveLength(1);

    const second = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(second.stopped).toBe(0);
    expect(second.notFound).toBe(1);
    expect(stops).toHaveLength(1); // no second stop
  });

  it("also converges when the gateway already forgot the run (not_found)", async () => {
    const { port, stops } = makePort({ probe: () => "not_found" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-old", status: "succeeded", externalRunId: "gw-forgotten" }],
      port,
      { quiet: true },
    );
    expect(result.stopped).toBe(0);
    expect(result.notFound).toBe(1);
    expect(stops).toEqual([]);
  });

  it("skips gateway runs that already terminated on their own", async () => {
    const { port, stops } = makePort({ probe: () => "terminal" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-old", status: "interrupted", externalRunId: "gw-done" }],
      port,
      { quiet: true },
    );
    expect(result.stopped).toBe(0);
    expect(result.probed).toBe(1);
    expect(stops).toEqual([]);
  });

  it("fail-open: an unreachable gateway changes nothing and reports unreachable", async () => {
    const { port, stops } = makePort({ probe: () => "unreachable" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-old", status: "failed", externalRunId: "gw-unknown" }],
      port,
      { quiet: true },
    );
    expect(result.stopped).toBe(0);
    expect(result.unreachable).toBe(1);
    expect(result.failed).toBe(0);
    expect(stops).toEqual([]);
  });

  it("counts a stop that did not land as failed, and retries on the next pass", async () => {
    const { port } = makePort({ probe: () => "live", onStop: () => ({ stopped: false }) });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-old", status: "cancelled", externalRunId: "gw-stuck" }],
      port,
      { quiet: true },
    );
    expect(result.stopped).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("does not probe terminal rows without a gateway run id", async () => {
    const { port, probes } = makePort({ probe: () => "live" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [
        { id: "run-a", status: "succeeded", externalRunId: null },
        { id: "run-b", status: "queued", externalRunId: null },
      ],
      port,
      { quiet: true },
    );
    expect(probes).toEqual([]);
    expect(result.scanned).toBe(2);
    expect(result.probed).toBe(0);
    expect(result.stopped).toBe(0);
    expect(result.skippedOwned).toBe(1);
  });

  it("a throw from a probe is contained: failed += 1, other rows still processed", async () => {
    const { port, stops } = makePort({
      probe: (id) => {
        if (id === "gw-boom") throw new Error("probe exploded");
        return "live";
      },
    });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [
        { id: "run-boom", status: "cancelled", externalRunId: "gw-boom" },
        { id: "run-ok", status: "cancelled", externalRunId: "gw-ok" },
      ],
      port,
      { quiet: true },
    );
    expect(result.failed).toBe(1);
    expect(result.stopped).toBe(1);
    expect(stops).toEqual(["gw-ok"]);
  });

  it("a throw from a stop is contained: failed += 1, no crash", async () => {
    const { port } = makePort({
      probe: () => "live",
      onStop: () => {
        throw new Error("stop exploded");
      },
    });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-old", status: "cancelled", externalRunId: "gw-stuck" }],
      port,
      { quiet: true },
    );
    expect(result.stopped).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("every TERMINAL status is a stop candidate when the gateway still reports live", async () => {
    const { port, stops } = makePort({ probe: () => "live" });
    const rows = TERMINAL_BOARD_RUN_STATUSES.map((status, i) => ({
      id: `run-${status}`,
      status,
      externalRunId: `gw-${i}`,
    }));
    const result = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(result.stopped).toBe(TERMINAL_BOARD_RUN_STATUSES.length);
    expect(stops).toHaveLength(TERMINAL_BOARD_RUN_STATUSES.length);
  });

  // myrmidon(OPE-12890): one pass resolves the agent's secrets once and hands
  // the credentials to every probe and stop; per-probe resolution wrote a
  // secret_access_events row per secret per probed run (~20k rows/hour).
  it("resolves secrets once per pass for K terminal runs (K=10), reusing credentials", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const { port, probes, resolveCalls, lastProbeCredentials, lastStopCredentials } = makePort({
      probe: () => "not_found",
    });
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `run-${i}`,
      status: "succeeded",
      externalRunId: `gw-${i}`,
    }));
    const result = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });

    expect(resolveCalls).toEqual([agent.id]); // 1 resolution, not 10
    expect(probes).toHaveLength(10);
    expect(result.probed).toBe(10);
    expect(result.notFound).toBe(10);
    // Every probe received the shared credentials, not its own resolution.
    expect(lastProbeCredentials()).toEqual({ baseUrl: "https://gw.example", apiKey: "k" });
    resetGatewaySlotProbeMemoryForTest();
  });

  it("a pass that stops runs also resolves once and passes credentials to stops", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const { port, stops, resolveCalls, lastStopCredentials } = makePort({ probe: () => "live" });
    const rows = [
      { id: "run-a", status: "cancelled", externalRunId: "gw-a" },
      { id: "run-b", status: "failed", externalRunId: "gw-b" },
    ];
    const result = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(resolveCalls).toEqual([agent.id]);
    expect(stops).toEqual(["gw-a", "gw-b"]);
    expect(result.stopped).toBe(2);
    expect(lastStopCredentials()).toEqual({ baseUrl: "https://gw.example", apiKey: "k" });
    resetGatewaySlotProbeMemoryForTest();
  });

  it("does not re-probe runs answered not_found in an earlier pass (probe memory)", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const { port, probes, resolveCalls } = makePort({ probe: () => "not_found" });
    const rows = [
      { id: "run-a", status: "succeeded", externalRunId: "gw-a" },
      { id: "run-b", status: "succeeded", externalRunId: "gw-b" },
    ];
    const first = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(first.probed).toBe(2);

    // Second pass over the same terminal runs: everything is remembered as
    // off-gateway — no probes, no extra resolution.
    const second = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true });
    expect(second.probed).toBe(0);
    expect(second.notFound).toBe(2);
    expect(resolveCalls).toEqual([agent.id]); // resolution happened only in pass 1
    resetGatewaySlotProbeMemoryForTest();
  });

  it("probe memory is per agent+gatewayRunId and expires (TTL bound to the lookback)", () => {
    resetGatewaySlotProbeMemoryForTest();
    expect(isGatewayRunConfirmedClosed("agent-x", "gw-z", 1_000)).toBe(false);
    markGatewayRunConfirmedClosed("agent-x", "gw-z", 1_000);
    expect(isGatewayRunConfirmedClosed("agent-x", "gw-z", 1_000 + 60_000)).toBe(true);
    // Another agent's run with the same gateway id is not remembered.
    expect(isGatewayRunConfirmedClosed("agent-y", "gw-z", 1_000 + 60_000)).toBe(false);
    // Past the TTL the entry is forgotten and a fresh probe is allowed.
    expect(isGatewayRunConfirmedClosed("agent-x", "gw-z", 1_000 + GATEWAY_SLOT_PROBE_MEMORY_TTL_MS + 1)).toBe(false);
    resetGatewaySlotProbeMemoryForTest();
  });

  it("terminal-probed runs and stopped runs are remembered as confirmed closed", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const stopping = makePort({ probe: () => "live" });
    await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-a", status: "cancelled", externalRunId: "gw-stopped" }],
      stopping.port,
      { quiet: true },
    );
    expect(isGatewayRunConfirmedClosed(agent.id, "gw-stopped")).toBe(true);

    const finishing = makePort({ probe: () => "terminal" });
    await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-b", status: "succeeded", externalRunId: "gw-self-done" }],
      finishing.port,
      { quiet: true },
    );
    expect(isGatewayRunConfirmedClosed(agent.id, "gw-self-done")).toBe(true);

    // Next pass over both: no probes at all.
    const { port, probes } = makePort({ probe: () => "live" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [
        { id: "run-a", status: "cancelled", externalRunId: "gw-stopped" },
        { id: "run-b", status: "succeeded", externalRunId: "gw-self-done" },
      ],
      port,
      { quiet: true },
    );
    expect(probes).toEqual([]);
    expect(result.probed).toBe(0);
    resetGatewaySlotProbeMemoryForTest();
  });

  it("unreachable probes and failed stops are NOT remembered (next pass retries)", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const unreachable = makePort({ probe: () => "unreachable" });
    await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-a", status: "cancelled", externalRunId: "gw-dark" }],
      unreachable.port,
      { quiet: true },
    );
    expect(isGatewayRunConfirmedClosed(agent.id, "gw-dark")).toBe(false);

    const failedStop = makePort({
      probe: () => "live",
      onStop: () => ({ stopped: false }),
    });
    await reconcileGatewaySlotsFromRows(
      agent,
      [{ id: "run-b", status: "cancelled", externalRunId: "gw-stuck" }],
      failedStop.port,
      { quiet: true },
    );
    expect(isGatewayRunConfirmedClosed(agent.id, "gw-stuck")).toBe(false);
    resetGatewaySlotProbeMemoryForTest();
  });

  it("a resolution failure does not break the pass: probes fall back to per-call resolution", async () => {
    resetGatewaySlotProbeMemoryForTest();
    const probes: string[] = [];
    let resolveCalls = 0;
    const port: GatewaySlotReconcilePort = {
      resolveCredentials: async () => {
        resolveCalls += 1;
        throw new Error("secrets unavailable");
      },
      probeGatewayRun: async ({ gatewayRunId, resolvedCredentials }) => {
        probes.push(`${gatewayRunId}:${resolvedCredentials ? "shared" : "own"}`);
        return { state: "not_found", status: null };
      },
      stopGatewayRunForBoard: async () => ({ stopped: true }),
    };
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [
        { id: "run-a", status: "succeeded", externalRunId: "gw-a" },
        { id: "run-b", status: "succeeded", externalRunId: "gw-b" },
      ],
      port,
      { quiet: true },
    );
    expect(resolveCalls).toBe(1); // attempted once, contained
    expect(result.notFound).toBe(2);
    expect(probes).toEqual(["gw-a:own", "gw-b:own"]); // per-call fallback, no crash
    resetGatewaySlotProbeMemoryForTest();
  });
});

describe("myrmidon(GATEWAY-SLOT-RECONCILE) run-start throttle", () => {
  it("holds a clean pass for the interval, re-arms immediately after a stop or failure", () => {
    resetGatewaySlotReconcileThrottleForTest();
    const now = 1_000_000;
    // First call always runs.
    expect(shouldReconcileGatewaySlotsForAgent("a", null, now)).toBe(true);
    recordGatewaySlotSweep("a", now);

    // Clean result: held for the interval.
    expect(shouldReconcileGatewaySlotsForAgent("a", { stopped: 0, failed: 0 }, now + 1)).toBe(false);
    expect(
      shouldReconcileGatewaySlotsForAgent(
        "a",
        { stopped: 0, failed: 0 },
        now + GATEWAY_SLOT_RECONCILE_INTERVAL_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldReconcileGatewaySlotsForAgent("a", { stopped: 0, failed: 0 }, now + GATEWAY_SLOT_RECONCILE_INTERVAL_MS),
    ).toBe(true);

    // A pass that stopped a slot re-arms immediately.
    recordGatewaySlotSweep("a", now + GATEWAY_SLOT_RECONCILE_INTERVAL_MS);
    expect(shouldReconcileGatewaySlotsForAgent("a", { stopped: 1, failed: 0 }, now + GATEWAY_SLOT_RECONCILE_INTERVAL_MS + 1)).toBe(true);
    expect(shouldReconcileGatewaySlotsForAgent("a", { stopped: 0, failed: 1 }, now + GATEWAY_SLOT_RECONCILE_INTERVAL_MS + 2)).toBe(true);

    resetGatewaySlotReconcileThrottleForTest();
  });

  it("reconcileGatewaySlotsOnRunStart returns null when throttled and never throws", async () => {
    resetGatewaySlotReconcileThrottleForTest();
    const db = {} as never; // throttled before any db use
    const port = makePort({ probe: () => "live" }).port;
    const first = await reconcileGatewaySlotsOnRunStart(db, port, "agent-throttle");
    expect(first).not.toBeNull();
    // The fake db has no select: the sweep throws, the wrapper contains it,
    // and the run-start path still gets a result object.
    expect(first).toMatchObject({ stopped: 0, unreachable: 1 });

    const second = await reconcileGatewaySlotsOnRunStart(db, port, "agent-throttle");
    expect(second).toBeNull();

    // A throwing sweep is contained: run start proceeds with a failed result.
    const throwingDb = {
      select: () => {
        throw new Error("db exploded");
      },
    } as never;
    recordGatewaySlotSweep("agent-throw", 1);
    resetGatewaySlotReconcileThrottleForTest();
    const contained = await reconcileGatewaySlotsOnRunStart(throwingDb, port, "agent-throw");
    expect(contained).toMatchObject({ stopped: 0, unreachable: 1 });
    resetGatewaySlotReconcileThrottleForTest();
  });
});
