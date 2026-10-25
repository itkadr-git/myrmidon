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

  it("is monotone and caps the delay at the six-event window budget", () => {
    const delays = Array.from({ length: MAX_EVENTS + 2 }, (_, recentCount) =>
      nextContinuationDelay({ recentCount, windowMs: WINDOW_MS }),
    );
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[MAX_EVENTS]).toBe(WINDOW_MS / MAX_EVENTS);
    expect(delays[MAX_EVENTS + 1]).toBe(delays[MAX_EVENTS]);
  });

  it("allows no more than six continuations in any rolling three-hour window", () => {
    const events = simulateWindow(WINDOW_MS, 20);
    for (let start = 0; start < events.length; start += 1) {
      const count = events.filter(
        (eventAt) => eventAt >= events[start]! && eventAt < events[start]! + WINDOW_MS,
      ).length;
      expect(count).toBeLessThanOrEqual(MAX_EVENTS);
    }
  });

  it("keeps the first event immediate and expires events at the window boundary", () => {
    const events = simulateWindow(WINDOW_MS, MAX_EVENTS + 1);
    expect(events[0]).toBe(0);
    expect(events[MAX_EVENTS]).toBe(WINDOW_MS);
    expect(events[MAX_EVENTS + 1]).toBe(WINDOW_MS + WINDOW_MS / MAX_EVENTS);
  });
});
