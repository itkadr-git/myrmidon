import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAKE_STORM_LIMIT,
  WakeStormGuard,
  readWakeStormSettings,
  wakeStormSourceKey,
} from "./wake-storm-guard.js";

describe("wake storm guard", () => {
  it("allows K wakes and pauses the source on the next wake", () => {
    const guard = new WakeStormGuard({ limit: 20, windowMs: 10_000 });
    for (let i = 0; i < 50; i += 1) {
      const result = guard.admit("agent-1", "rule-1", i * 100);
      expect(result.allowed).toBe(i < 20);
      expect(result.tripped).toBe(i === 20);
    }
  });

  it("keeps sources and agents independent and resumes after the window", () => {
    const guard = new WakeStormGuard({ limit: 2, windowMs: 10 });
    expect(guard.admit("a", "r", 0).allowed).toBe(true);
    expect(guard.admit("a", "r", 1).allowed).toBe(true);
    expect(guard.admit("a", "r", 2).tripped).toBe(true);
    expect(guard.admit("a", "other", 2).allowed).toBe(true);
    expect(guard.admit("b", "r", 2).allowed).toBe(true);
    expect(guard.admit("a", "r", 11).allowed).toBe(true);
  });

  it("reads configurable settings and resolves an explicit source key", () => {
    expect(readWakeStormSettings({ MYRMIDON_WAKE_STORM_LIMIT: "7", MYRMIDON_WAKE_STORM_WINDOW_MS: "2500" })).toEqual({ limit: 7, windowMs: 2500 });
    expect(readWakeStormSettings({}).limit).toBe(DEFAULT_WAKE_STORM_LIMIT);
    expect(wakeStormSourceKey({ reason: "fallback", payload: { watchdogId: "wd-1" } })).toBe("wd-1");
    expect(wakeStormSourceKey({ source: "automation", reason: "fallback" })).toBe("fallback");
  });
});
