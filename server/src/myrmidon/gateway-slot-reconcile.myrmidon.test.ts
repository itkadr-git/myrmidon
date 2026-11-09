import { describe, expect, it } from "vitest";
import {
  GATEWAY_SLOT_RECONCILE_INTERVAL_MS,
  OWNED_BOARD_RUN_STATUSES,
  TERMINAL_BOARD_RUN_STATUSES,
  reconcileGatewaySlotsFromRows,
  recordGatewaySlotSweep,
  reconcileGatewaySlotsOnRunStart,
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
