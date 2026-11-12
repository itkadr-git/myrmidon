// myrmidon(OPE-12807): the revisit cool-down of deferred wakes.
import { describe, expect, it } from "vitest";
import {
  DEFERRED_WAKE_FRESH_WINDOW_MS,
  DEFERRED_WAKE_REVISIT_COOLDOWN_MS,
  deferredWakeFreshSince,
  deferredWakeRevisitCutoff,
  isDeferredWakeRevisitDue,
} from "./deferred-wake-revisit.js";

const NOW = Date.parse("2026-11-12T00:00:00Z");

describe("deferred wake revisit cool-down", () => {
  it("does not revisit a wake that was looked at inside the cool-down (the old 30 s gate did)", () => {
    expect(isDeferredWakeRevisitDue(new Date(NOW - 30_000), NOW)).toBe(false);
    expect(isDeferredWakeRevisitDue(new Date(NOW - DEFERRED_WAKE_REVISIT_COOLDOWN_MS + 1), NOW)).toBe(false);
  });

  it("revisits a wake once the cool-down is over, and one never looked at", () => {
    expect(isDeferredWakeRevisitDue(new Date(NOW - DEFERRED_WAKE_REVISIT_COOLDOWN_MS), NOW)).toBe(true);
    expect(isDeferredWakeRevisitDue(new Date(NOW - 3_600_000), NOW)).toBe(true);
    expect(isDeferredWakeRevisitDue(null, NOW)).toBe(true);
  });

  it("the cut-off is the cool-down before now", () => {
    expect(deferredWakeRevisitCutoff(NOW).getTime()).toBe(NOW - DEFERRED_WAKE_REVISIT_COOLDOWN_MS);
    expect(DEFERRED_WAKE_REVISIT_COOLDOWN_MS).toBeGreaterThan(30_000);
  });

  it("the fresh window is bounded, so a long-stranded wake is always paced by the cool-down", () => {
    expect(deferredWakeFreshSince(NOW).getTime()).toBe(NOW - DEFERRED_WAKE_FRESH_WINDOW_MS);
    expect(DEFERRED_WAKE_FRESH_WINDOW_MS).toBeGreaterThan(0);
    expect(DEFERRED_WAKE_FRESH_WINDOW_MS).toBeLessThanOrEqual(60 * 60_000);
  });
});
