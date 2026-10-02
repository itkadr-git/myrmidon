// myrmidon(TRACING-HEALTH) domain tests: the pure state machine over probe
// evidence. Neutral data only.

import { describe, expect, it } from "vitest";
import {
  CALLBACK_ERROR_RATE_THRESHOLD,
  computeTracingHealthState,
  REASONS,
  type TracingHealthEvidence,
} from "./domain.js";

const NOW = () => "2026-10-02T10:00:00.000Z";

describe("myrmidon(TRACING-HEALTH) state machine", () => {
  const ev = (overrides: Partial<TracingHealthEvidence> = {}): TracingHealthEvidence => ({
    eventsInWindow: 120,
    gatewayRequestsInWindow: 130,
    callbackErrorRate: 0,
    ...overrides,
  });

  it("ok: events flowed while the gateway served traffic and the callback error rate is ~0", () => {
    const result = computeTracingHealthState(ev());
    expect(result).toEqual({ state: "ok", reason: REASONS.ok });
  });

  it("idle: no gateway traffic in the window is OK with a reason, not broken", () => {
    const result = computeTracingHealthState(ev({ gatewayRequestsInWindow: 0, eventsInWindow: 0 }));
    expect(result).toEqual({ state: "idle", reason: REASONS.idle });
  });

  it("idle wins even with a stale error rate (quiet periods are not degraded)", () => {
    const result = computeTracingHealthState(
      ev({ gatewayRequestsInWindow: 0, eventsInWindow: 0, callbackErrorRate: 1 }),
    );
    expect(result.state).toBe("idle");
  });

  it("degraded: traffic but zero events — the 02.10 incident class", () => {
    const result = computeTracingHealthState(ev({ eventsInWindow: 0 }));
    expect(result).toEqual({ state: "degraded", reason: REASONS.degradedNoEvents });
  });

  it("degraded: callback error rate at or above the threshold", () => {
    const result = computeTracingHealthState(ev({ callbackErrorRate: CALLBACK_ERROR_RATE_THRESHOLD }));
    expect(result).toEqual({ state: "degraded", reason: REASONS.degradedCallbackErrors });
    expect(computeTracingHealthState(ev({ callbackErrorRate: 1 })).state).toBe("degraded");
    expect(computeTracingHealthState(ev({ callbackErrorRate: 0.019 })).state).toBe("ok");
  });

  it("a null callback error rate does not fail an otherwise healthy window", () => {
    const result = computeTracingHealthState(ev({ callbackErrorRate: null }));
    expect(result.state).toBe("ok");
  });

  it("unknown: each single probe failure, and both together", () => {
    expect(computeTracingHealthState(ev({ eventsInWindow: null }))).toEqual({
      state: "unknown",
      reason: REASONS.unknownEvents,
    });
    expect(computeTracingHealthState(ev({ gatewayRequestsInWindow: null }))).toEqual({
      state: "unknown",
      reason: REASONS.unknownGateway,
    });
    expect(computeTracingHealthState(ev({ eventsInWindow: null, gatewayRequestsInWindow: null }))).toEqual({
      state: "unknown",
      reason: REASONS.unknownBoth,
    });
  });

  it("unknown outranks degraded: a broken check never reads as healthy", () => {
    expect(computeTracingHealthState(ev({ eventsInWindow: null, gatewayRequestsInWindow: 5 })).state).toBe("unknown");
    expect(computeTracingHealthState(ev({ eventsInWindow: null, gatewayRequestsInWindow: 0 })).state).toBe("unknown");
  });

  it("is total: every combination of nulls and zeros yields a defined state", () => {
    for (const eventsInWindow of [null, 0, 10] as const) {
      for (const gatewayRequestsInWindow of [null, 0, 10] as const) {
        for (const callbackErrorRate of [null, 0, 0.5] as const) {
          const result = computeTracingHealthState({ eventsInWindow, gatewayRequestsInWindow, callbackErrorRate });
          expect(["ok", "idle", "degraded", "unknown"]).toContain(result.state);
          expect(typeof result.reason).toBe("string");
        }
      }
    }
  });

  it("a custom threshold is honoured", () => {
    expect(computeTracingHealthState(ev({ callbackErrorRate: 0.05 }), 0.1).state).toBe("ok");
    expect(computeTracingHealthState(ev({ callbackErrorRate: 0.05 }), 0.01).state).toBe("degraded");
  });

  it("the report contract shape is exactly the frozen JSON for part D", () => {
    // compile-time shape guard: a report built with the contract fields type
    // as TracingHealthReport; part D depends on the exact field set.
    const report = {
      enabled: true,
      state: "ok" as const,
      checkedAt: NOW(),
      window: { from: NOW(), to: NOW() },
      evidence: ev(),
      reason: REASONS.ok,
    };
    expect(Object.keys(report).sort()).toEqual([
      "checkedAt",
      "enabled",
      "evidence",
      "reason",
      "state",
      "window",
    ]);
    expect(Object.keys(report.evidence).sort()).toEqual([
      "callbackErrorRate",
      "eventsInWindow",
      "gatewayRequestsInWindow",
    ]);
    expect(Object.keys(report.window).sort()).toEqual(["from", "to"]);
  });
});
