import { describe, expect, it } from "vitest";
import {
  GATEWAY_SLOT_RECONCILE_INTERVAL_MS,
  OWNED_BOARD_RUN_STATUSES,
  TERMINAL_BOARD_RUN_STATUSES,
  reconcileGatewaySlotsFromRows,
  recordGatewaySlotSweep,
  reconcileGatewaySlotsOnRunStart,
  sweepGatewaySlotsForAgent,
  resetGatewaySlotReconcileThrottleForTest,
  shouldReconcileGatewaySlotsForAgent,
  type GatewaySlotReconcilePort,
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
  const port: GatewaySlotReconcilePort = {
    probeGatewayRun: async ({ gatewayRunId }) => {
      probes.push(gatewayRunId);
      return { state: options.probe(gatewayRunId), status: "running" };
    },
    stopGatewayRunForBoard: async ({ gatewayRunId }) => {
      stops.push(gatewayRunId);
      const outcome = options.onStop
        ? await options.onStop(gatewayRunId)
        : { stopped: true };
      return outcome;
    },
  };
  return { port, probes, stops };
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
});

describe("myrmidon(OPE-12964) settled gateway runs are not probed again", () => {
  const rows = [
    { id: "run-a", status: "succeeded", externalRunId: "gw-a" },
    { id: "run-b", status: "failed", externalRunId: "gw-b" },
  ];

  it("a second pass over the same finished runs does not call probeGatewayRun", async () => {
    const settled = new Set<string>();
    const { port, probes } = makePort({ probe: (id) => (id === "gw-a" ? "terminal" : "not_found") });
    const first = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true, settled });
    expect(probes).toEqual(["gw-a", "gw-b"]);
    expect(first.probed).toBe(2);

    const second = await reconcileGatewaySlotsFromRows(agent, rows, port, { quiet: true, settled });
    expect(probes).toEqual(["gw-a", "gw-b"]); // no new probe
    expect(second.scanned).toBe(2);
    expect(second.probed).toBe(0);
    expect(second.skippedSettled).toBe(2);
  });

  it("unreachable is not remembered: the run is probed again on the next pass", async () => {
    const settled = new Set<string>();
    const { port, probes } = makePort({ probe: () => "unreachable" });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], port, { quiet: true, settled });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], port, { quiet: true, settled });
    expect(probes).toEqual(["gw-a", "gw-a"]);
    expect(settled.has("run-a")).toBe(false);
  });

  it("the first unreachable probe ends the pass; the remaining rows are not probed", async () => {
    const { port, probes } = makePort({ probe: () => "unreachable" });
    const result = await reconcileGatewaySlotsFromRows(
      agent,
      [...rows, { id: "run-c", status: "cancelled", externalRunId: "gw-c" }],
      port,
      { quiet: true },
    );
    expect(probes).toEqual(["gw-a"]);
    expect(result.scanned).toBe(3);
    expect(result.unreachable).toBe(1);
  });

  it("a thrown probe is not remembered", async () => {
    const settled = new Set<string>();
    const { port, probes } = makePort({
      probe: () => {
        throw new Error("boom");
      },
    });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], port, { quiet: true, settled });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], port, { quiet: true, settled });
    expect(probes).toEqual(["gw-a", "gw-a"]);
  });

  it("live with an accepted stop is remembered; live with a refused stop is probed again", async () => {
    const accepted = new Set<string>();
    const ok = makePort({ probe: () => "live", onStop: () => ({ stopped: true }) });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], ok.port, { quiet: true, settled: accepted });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], ok.port, { quiet: true, settled: accepted });
    expect(ok.probes).toEqual(["gw-a"]);
    expect(ok.stops).toEqual(["gw-a"]);

    const refused = new Set<string>();
    const no = makePort({ probe: () => "live", onStop: () => ({ stopped: false }) });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], no.port, { quiet: true, settled: refused });
    await reconcileGatewaySlotsFromRows(agent, [rows[0]!], no.port, { quiet: true, settled: refused });
    expect(no.probes).toEqual(["gw-a", "gw-a"]);
    expect(refused.has("run-a")).toBe(false);
  });

  it("sweep keeps the memory process-locally and prunes entries older than the lookback", async () => {
    resetGatewaySlotReconcileThrottleForTest();
    let call = 0;
    const db = {
      select: () => {
        const isAgentQuery = call++ % 2 === 0;
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ id: agent.id, companyId: agent.companyId, adapterType: "hermes_gateway", adapterConfig: {} }],
              orderBy: () => ({ limit: async () => (isAgentQuery ? [] : rows) }),
            }),
          }),
        };
      },
    } as never;
    const { port, probes } = makePort({ probe: () => "not_found" });
    const t0 = 5_000_000;
    await sweepGatewaySlotsForAgent(db, port, { agentId: agent.id }, { quiet: true, lookbackMs: 1000, nowMs: t0 });
    expect(probes).toEqual(["gw-a", "gw-b"]);
    await sweepGatewaySlotsForAgent(db, port, { agentId: agent.id }, { quiet: true, lookbackMs: 1000, nowMs: t0 + 500 });
    expect(probes).toEqual(["gw-a", "gw-b"]); // remembered
    await sweepGatewaySlotsForAgent(db, port, { agentId: agent.id }, { quiet: true, lookbackMs: 1000, nowMs: t0 + 2000 });
    expect(probes).toEqual(["gw-a", "gw-b", "gw-a", "gw-b"]); // pruned, probed again
    resetGatewaySlotReconcileThrottleForTest();
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
