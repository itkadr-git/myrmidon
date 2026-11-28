import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStartupRecoveryState,
  resetStartupRecoveryStateForTests,
  setStartupRecoveryPhase,
} from "../startup-recovery-state.js";

describe("startup recovery state", () => {
  afterEach(() => {
    resetStartupRecoveryStateForTests();
    vi.useRealTimers();
  });

  it("records each transition and refreshes the timestamp for a repeated phase", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    setStartupRecoveryPhase("starting");
    expect(getStartupRecoveryState()).toEqual({ phase: "starting", updatedAt: "2026-01-01T00:00:00.000Z" });

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    setStartupRecoveryPhase("recovering");
    expect(getStartupRecoveryState()).toEqual({ phase: "recovering", updatedAt: "2026-01-01T00:00:01.000Z" });

    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    setStartupRecoveryPhase("recovering");
    expect(getStartupRecoveryState()).toEqual({ phase: "recovering", updatedAt: "2026-01-01T00:00:02.000Z" });

    vi.setSystemTime(new Date("2026-01-01T00:00:03.000Z"));
    setStartupRecoveryPhase("ready");
    expect(getStartupRecoveryState()).toEqual({ phase: "ready", updatedAt: "2026-01-01T00:00:03.000Z" });
  });

  it("returns independent snapshots that cannot mutate module state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    setStartupRecoveryPhase("starting");
    const earlier = getStartupRecoveryState();
    expect(earlier).toEqual({ phase: "starting", updatedAt: "2026-02-01T00:00:00.000Z" });

    vi.setSystemTime(new Date("2026-02-01T00:00:01.000Z"));
    setStartupRecoveryPhase("recovering");
    expect(earlier).toEqual({ phase: "starting", updatedAt: "2026-02-01T00:00:00.000Z" });
    const returned = getStartupRecoveryState();
    expect(returned).toEqual({ phase: "recovering", updatedAt: "2026-02-01T00:00:01.000Z" });
    returned.phase = "ready";
    returned.updatedAt = "modified";
    expect(getStartupRecoveryState()).toEqual({ phase: "recovering", updatedAt: "2026-02-01T00:00:01.000Z" });
  });

  it.each(["starting", "recovering", "ready"] as const)("resets %s to ready at the reset time", (phase) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    setStartupRecoveryPhase(phase);
    expect(getStartupRecoveryState()).toEqual({ phase, updatedAt: "2026-03-01T00:00:00.000Z" });
    vi.setSystemTime(new Date("2026-03-01T00:00:01.000Z"));
    resetStartupRecoveryStateForTests();
    expect(getStartupRecoveryState()).toEqual({ phase: "ready", updatedAt: "2026-03-01T00:00:01.000Z" });
  });

  it("isolates consecutive scenarios when reset between them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
    setStartupRecoveryPhase("recovering");
    expect(getStartupRecoveryState()).toEqual({ phase: "recovering", updatedAt: "2026-04-01T00:00:00.000Z" });
    vi.setSystemTime(new Date("2026-04-01T00:00:01.000Z"));
    resetStartupRecoveryStateForTests();
    expect(getStartupRecoveryState()).toEqual({ phase: "ready", updatedAt: "2026-04-01T00:00:01.000Z" });
    vi.setSystemTime(new Date("2026-04-01T00:00:02.000Z"));
    setStartupRecoveryPhase("starting");
    expect(getStartupRecoveryState()).toEqual({ phase: "starting", updatedAt: "2026-04-01T00:00:02.000Z" });
  });
});
