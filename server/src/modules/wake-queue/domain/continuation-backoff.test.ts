import { describe, expect, it } from "vitest";
import { nextContinuationDelay } from "./continuation-backoff.js";

const WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_EVENTS = 6;

function simulateWindow(windowMs: number, requestCount: number): number[] {
  const acceptedAt: number[] = [];
  let time = 0;

  for (let request = 0; request < requestCount; request += 1) {
    const recent = acceptedAt.filter((eventAt) => eventAt > time - windowMs);
    time += nextContinuationDelay({ recentCount: recent.length, windowMs });
    acceptedAt.push(time);
  }

  return acceptedAt;
}

describe("nextContinuationDelay", () => {
  it("returns no delay when there are no recent events", () => {
    expect(nextContinuationDelay({ recentCount: 0, windowMs: WINDOW_MS })).toBe(0);
  });

  it("increases delay with the event count and waits for a slot above budget", () => {
    const delays = Array.from({ length: MAX_EVENTS + 3 }, (_, recentCount) =>
      nextContinuationDelay({ recentCount, windowMs: WINDOW_MS }),
    );
    expect(delays.slice(0, MAX_EVENTS + 1)).toEqual([...delays.slice(0, MAX_EVENTS + 1)].sort((a, b) => a - b));
    expect(delays.slice(1, 6)).toEqual([WINDOW_MS / 6, 2 * WINDOW_MS / 6, 3 * WINDOW_MS / 6, 4 * WINDOW_MS / 6, 5 * WINDOW_MS / 6]);
    expect(delays[MAX_EVENTS]).toBe(WINDOW_MS);
    expect(delays[MAX_EVENTS + 2]).toBe(WINDOW_MS);
  });

  it("allows no more than six events in every rolling three-hour window", () => {
    const events = simulateWindow(WINDOW_MS, 30);
    for (let start = 0; start < events.length; start += 1) {
      const count = events.filter((eventAt) => eventAt >= events[start]! && eventAt < events[start]! + WINDOW_MS).length;
      expect(count).toBeLessThanOrEqual(MAX_EVENTS);
    }
  });

  it("handles a dense batch at the window boundary", () => {
    const events = simulateWindow(WINDOW_MS, MAX_EVENTS + 2);
    expect(events.slice(0, MAX_EVENTS)).toEqual([0, WINDOW_MS / 6, 3 * WINDOW_MS / 6, 6 * WINDOW_MS / 6, 9 * WINDOW_MS / 6, 11 * WINDOW_MS / 6]);
    expect(events[MAX_EVENTS]).toBe(7 * WINDOW_MS / 3);
    expect(events[MAX_EVENTS + 1]).toBe(17 * WINDOW_MS / 6);
  });

  it("uses an arbitrary configured window and budget without truncating the window", () => {
    expect(nextContinuationDelay({ recentCount: 2, windowMs: 1_000, maxContinuations: 4, maxDelayMs: 2_000 })).toBe(500);
    expect(nextContinuationDelay({ recentCount: 4, windowMs: 1_000, maxContinuations: 4, maxDelayMs: 2_000 })).toBe(1_000);
    expect(nextContinuationDelay({ recentCount: 4, windowMs: 10_000, maxContinuations: 4, maxDelayMs: 2_000 })).toBe(2_000);
  });

  it("returns zero for NaN and negative inputs", () => {
    expect(nextContinuationDelay({ recentCount: Number.NaN, windowMs: WINDOW_MS })).toBe(0);
    expect(nextContinuationDelay({ recentCount: -1, windowMs: WINDOW_MS })).toBe(0);
    expect(nextContinuationDelay({ recentCount: 1, windowMs: Number.NaN })).toBe(0);
    expect(nextContinuationDelay({ recentCount: 1, windowMs: -1 })).toBe(0);
  });
});
