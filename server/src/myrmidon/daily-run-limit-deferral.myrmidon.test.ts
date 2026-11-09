import { describe, expect, it } from "vitest";
import {
  DAILY_RUN_LIMIT_DEFER_JITTER_MS,
  DAILY_RUN_LIMIT_DEFERRAL_CONTEXT_KEY,
  DAILY_RUN_LIMIT_RETRY_REASON,
  computeDailyRunLimitDeferral,
} from "./daily-run-limit-deferral.js";

const RESET_AT = new Date("2026-11-08T00:00:00.000Z");

describe("daily run limit deferral (OPE-11718)", () => {
  it("names the gate's refusal reason and the context key of the marker", () => {
    expect(DAILY_RUN_LIMIT_RETRY_REASON).toBe("heartbeat.daily_run_limit");
    expect(DAILY_RUN_LIMIT_DEFERRAL_CONTEXT_KEY).toBe("dailyRunLimitDeferral");
  });

  it("takes the reset from the gate's window end, not from a clock of its own", () => {
    // The gate counted in the day that ends at RESET_AT. Whatever the clock
    // says now, the run is due at that end and not a day later.
    const deferral = computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 40, random: () => 0 });
    expect(deferral?.resetAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(deferral?.dueAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });

  it("falls due at the reset plus a jitter that stays inside the jitter window", () => {
    const latest = computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 40, random: () => 1 });
    expect(latest!.dueAt.getTime() - RESET_AT.getTime()).toBe(DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1);

    const middle = computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 40, random: () => 0.5 });
    expect(middle!.dueAt.getTime() - RESET_AT.getTime()).toBe(DAILY_RUN_LIMIT_DEFER_JITTER_MS / 2);
  });

  it("spreads runs deferred at the same moment over distinct due times", () => {
    const dueTimes = new Set(
      Array.from({ length: 50 }, () => computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 40 })!.dueAt.getTime()),
    );
    expect(dueTimes.size).toBeGreaterThan(40);
    for (const dueMs of dueTimes) {
      expect(dueMs).toBeGreaterThanOrEqual(RESET_AT.getTime());
      expect(dueMs - RESET_AT.getTime()).toBeLessThan(DAILY_RUN_LIMIT_DEFER_JITTER_MS);
    }
  });

  it("clamps a random source that leaves [0, 1]", () => {
    expect(computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 1, random: () => -5 })?.dueAt.getTime())
      .toBe(RESET_AT.getTime());
    expect(computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 1, random: () => 7 })?.dueAt.getTime())
      .toBe(RESET_AT.getTime() + DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1);
  });

  it("gives no jitter when the random source returns NaN or an infinity, and never an invalid date", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const deferral = computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 1, random: () => bad });
      expect(deferral).not.toBeNull();
      expect(Number.isNaN(deferral!.dueAt.getTime())).toBe(false);
      expect(deferral!.dueAt.getTime()).toBe(RESET_AT.getTime());
    }
  });

  it("does not defer when no reset can free a slot (limit zero or not a number) or the window end is invalid", () => {
    expect(computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: 0 })).toBeNull();
    expect(computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: -1 })).toBeNull();
    expect(computeDailyRunLimitDeferral({ resetAt: RESET_AT, limit: Number.NaN })).toBeNull();
    expect(computeDailyRunLimitDeferral({ resetAt: new Date(Number.NaN), limit: 5 })).toBeNull();
  });
});
