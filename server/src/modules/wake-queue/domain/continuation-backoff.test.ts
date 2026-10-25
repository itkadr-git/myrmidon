import { describe, expect, it } from "vitest";
import { nextContinuationDelay } from "./continuation-backoff.js";

describe("nextContinuationDelay", () => {
  it("returns no delay when there are no recent events", () => {
    expect(nextContinuationDelay({ recentCount: 0, windowMs: 3 * 60 * 60 * 1000 })).toBe(0);
  });

  it("is monotone and capped by the window's event budget", () => {
    const windowMs = 3 * 60 * 60 * 1000;
    const delays = Array.from({ length: 32 }, (_, recentCount) =>
      nextContinuationDelay({ recentCount, windowMs }),
    );
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[30]).toBeLessThanOrEqual(windowMs / 6);
    expect(delays[31]).toBe(delays[30]);
  });
});