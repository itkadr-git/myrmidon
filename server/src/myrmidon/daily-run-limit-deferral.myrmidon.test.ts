import { describe, expect, it } from "vitest";
import {
  DAILY_RUN_LIMIT_DEFER_JITTER_MS,
  DAILY_RUN_LIMIT_RETRY_REASON,
  computeDailyRunLimitDeferral,
  nextDailyRunLimitReset,
} from "./daily-run-limit-deferral.js";

describe("daily run limit deferral (OPE-11718)", () => {
  it("names the gate's own refusal reason as the retry reason", () => {
    expect(DAILY_RUN_LIMIT_RETRY_REASON).toBe("heartbeat.daily_run_limit");
  });

  it("resets at the first instant of the next UTC day, whatever the time of day", () => {
    expect(nextDailyRunLimitReset(new Date("2026-11-07T00:00:00.000Z")).toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(nextDailyRunLimitReset(new Date("2026-11-07T23:59:59.999Z")).toISOString()).toBe("2026-11-08T00:00:00.000Z");
    // The local zone does not move it: 08:00 at UTC+8 is still 00:00 UTC of the same day.
    expect(nextDailyRunLimitReset(new Date("2026-11-07T08:00:00+08:00")).toISOString()).toBe("2026-11-08T00:00:00.000Z");
  });

  it("rolls over month and year ends", () => {
    expect(nextDailyRunLimitReset(new Date("2026-11-30T12:00:00Z")).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(nextDailyRunLimitReset(new Date("2026-12-31T12:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextDailyRunLimitReset(new Date("2028-02-28T12:00:00Z")).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("falls due at the reset plus a jitter that stays inside the jitter window", () => {
    const now = new Date("2026-11-07T10:30:00Z");
    const resetAt = "2026-11-08T00:00:00.000Z";

    const earliest = computeDailyRunLimitDeferral({ now, limit: 40, random: () => 0 });
    expect(earliest?.resetAt.toISOString()).toBe(resetAt);
    expect(earliest?.dueAt.toISOString()).toBe(resetAt);

    const latest = computeDailyRunLimitDeferral({ now, limit: 40, random: () => 1 });
    expect(latest?.dueAt.getTime()).toBeGreaterThan(new Date(resetAt).getTime());
    expect(latest!.dueAt.getTime() - new Date(resetAt).getTime()).toBe(DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1);

    const middle = computeDailyRunLimitDeferral({ now, limit: 40, random: () => 0.5 });
    expect(middle!.dueAt.getTime() - new Date(resetAt).getTime()).toBe(DAILY_RUN_LIMIT_DEFER_JITTER_MS / 2);
  });

  it("spreads runs deferred at the same moment over distinct due times", () => {
    const now = new Date("2026-11-07T10:30:00Z");
    const dueTimes = new Set(
      Array.from({ length: 50 }, () => computeDailyRunLimitDeferral({ now, limit: 40 })!.dueAt.getTime()),
    );
    expect(dueTimes.size).toBeGreaterThan(40);
    const resetMs = new Date("2026-11-08T00:00:00Z").getTime();
    for (const dueMs of dueTimes) {
      expect(dueMs).toBeGreaterThanOrEqual(resetMs);
      expect(dueMs - resetMs).toBeLessThan(DAILY_RUN_LIMIT_DEFER_JITTER_MS);
    }
  });

  it("clamps a random source that leaves [0, 1]", () => {
    const now = new Date("2026-11-07T10:30:00Z");
    const resetMs = new Date("2026-11-08T00:00:00Z").getTime();
    expect(computeDailyRunLimitDeferral({ now, limit: 1, random: () => -5 })?.dueAt.getTime()).toBe(resetMs);
    expect(computeDailyRunLimitDeferral({ now, limit: 1, random: () => 7 })?.dueAt.getTime())
      .toBe(resetMs + DAILY_RUN_LIMIT_DEFER_JITTER_MS - 1);
  });

  it("does not defer when no reset can free a slot (limit zero or not a number)", () => {
    const now = new Date("2026-11-07T10:30:00Z");
    expect(computeDailyRunLimitDeferral({ now, limit: 0 })).toBeNull();
    expect(computeDailyRunLimitDeferral({ now, limit: -1 })).toBeNull();
    expect(computeDailyRunLimitDeferral({ now, limit: Number.NaN })).toBeNull();
  });
});
