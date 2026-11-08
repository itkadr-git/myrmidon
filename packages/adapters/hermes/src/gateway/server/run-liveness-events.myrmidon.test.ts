// myrmidon(N4-RUN-LIVENESS): unit tests for the event-based run liveness watch
// (MYRMIDON_RUN_LIVENESS_EVENTS, default off). The watch replaces the fixed
// wall-clock timeout with a silence check: a run that keeps emitting gateway
// events is alive past its timeoutSec; only a run silent for the whole budget
// stalls.
import { describe, expect, it, vi } from "vitest";
import {
  installRunLivenessWatch,
  resolveRunLivenessEvents,
  touchRunLiveness,
  type RunLivenessState,
} from "./run-liveness-events.js";

describe("resolveRunLivenessEvents", () => {
  it("is off by default (no env, no card toggle)", () => {
    expect(resolveRunLivenessEvents(undefined, {})).toBe(false);
  });

  it("ignores unrecognised env values (typo keeps the old timeout)", () => {
    expect(resolveRunLivenessEvents(undefined, { MYRMIDON_RUN_LIVENESS_EVENTS: "yes please" })).toBe(false);
    expect(resolveRunLivenessEvents(undefined, { MYRMIDON_RUN_LIVENESS_EVENTS: "0" })).toBe(false);
    expect(resolveRunLivenessEvents(undefined, { MYRMIDON_RUN_LIVENESS_EVENTS: "false" })).toBe(false);
  });

  it("turns on for truthy env values", () => {
    for (const value of ["1", "true", "TRUE", "on", "yes", " 1 "]) {
      expect(resolveRunLivenessEvents(undefined, { MYRMIDON_RUN_LIVENESS_EVENTS: value })).toBe(true);
    }
  });

  it("lets the card toggle override the environment", () => {
    expect(resolveRunLivenessEvents(false, { MYRMIDON_RUN_LIVENESS_EVENTS: "1" })).toBe(false);
    expect(resolveRunLivenessEvents("off", { MYRMIDON_RUN_LIVENESS_EVENTS: "1" })).toBe(false);
    expect(resolveRunLivenessEvents(true, {})).toBe(true);
    expect(resolveRunLivenessEvents("true", {})).toBe(true);
  });
});

describe("installRunLivenessWatch", () => {
  function makeState(at = 1_000): RunLivenessState {
    return { lastEventAtMs: at };
  }

  it("fires once the silence reaches the timeout budget", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const onStalled = vi.fn();
    const dispose = installRunLivenessWatch({
      state: makeState(1_000),
      timeoutMs: 5_000,
      onStalled,
      now: () => clock,
      checkIntervalMs: 1_000,
    });
    clock = 7_000; // 6s of silence
    vi.advanceTimersByTime(1_000);
    expect(onStalled).toHaveBeenCalledTimes(1);
    dispose();
    vi.useRealTimers();
  });

  it("does not fire while fresh gateway events keep arriving", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const state = makeState(1_000);
    const onStalled = vi.fn();
    const dispose = installRunLivenessWatch({
      state,
      timeoutMs: 5_000,
      onStalled,
      now: () => clock,
      checkIntervalMs: 1_000,
    });
    // Events every 2s, for 20s — four times the budget, never 5s of silence.
    for (let i = 0; i < 10; i += 1) {
      clock += 2_000;
      touchRunLiveness(state, clock);
      vi.advanceTimersByTime(2_000);
    }
    expect(onStalled).not.toHaveBeenCalled();
    dispose();
    vi.useRealTimers();
  });

  it("fires after events stop and silence exceeds the budget", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const state = makeState(1_000);
    const onStalled = vi.fn();
    const dispose = installRunLivenessWatch({
      state,
      timeoutMs: 5_000,
      onStalled,
      now: () => clock,
      checkIntervalMs: 1_000,
    });
    clock += 2_000;
    touchRunLiveness(state, clock);
    vi.advanceTimersByTime(2_000);
    expect(onStalled).not.toHaveBeenCalled();
    clock += 6_000; // stream dies
    vi.advanceTimersByTime(1_000);
    expect(onStalled).toHaveBeenCalledTimes(1);
    dispose();
    vi.useRealTimers();
  });

  it("a run with no events at all stalls exactly at its budget", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const onStalled = vi.fn();
    const dispose = installRunLivenessWatch({
      state: makeState(1_000),
      timeoutMs: 5_000,
      onStalled,
      now: () => clock,
      checkIntervalMs: 1_000,
    });
    clock = 5_999;
    vi.advanceTimersByTime(5_000);
    expect(onStalled).not.toHaveBeenCalled();
    clock = 6_001;
    vi.advanceTimersByTime(1_000);
    expect(onStalled).toHaveBeenCalledTimes(1);
    dispose();
    vi.useRealTimers();
  });

  it("dispose stops the watch (a finished run never stalls afterwards)", () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const onStalled = vi.fn();
    const dispose = installRunLivenessWatch({
      state: makeState(1_000),
      timeoutMs: 5_000,
      onStalled,
      now: () => clock,
      checkIntervalMs: 1_000,
    });
    dispose();
    clock += 60_000;
    vi.advanceTimersByTime(60_000);
    expect(onStalled).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
