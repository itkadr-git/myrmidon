import { describe, expect, it } from "vitest";
import { collectDevflowDurations, evaluateDevflowThresholds } from "./thresholds.js";

const now = new Date("2026-10-27T20:00:00.000Z");

describe("DEVFLOW health thresholds", () => {
  it("alerts at or above configured thresholds without a model call", () => {
    expect(evaluateDevflowThresholds({ engineerIdleMs: 10, reviewQueueAgeMs: 20, redCiMs: 30 }, {
      engineerIdleMs: 10, reviewQueueAgeMs: 21, redCiMs: 30,
    })).toEqual([
      { metric: "engineerIdleMs", durationMs: 10, thresholdMs: 10 },
      { metric: "redCiMs", durationMs: 30, thresholdMs: 30 },
    ]);
  });

  it("does not alert below thresholds and ignores missing values", () => {
    expect(evaluateDevflowThresholds({ engineerIdleMs: 9, reviewQueueAgeMs: undefined })).toEqual([]);
  });

  it("collects persisted timestamp ages", () => {
    expect(collectDevflowDurations({
      engineerLastHeartbeatAt: "2026-10-27T19:00:00.000Z",
      reviewEnteredAt: "2026-10-27T19:30:00.000Z",
      ciRedSince: null,
    }, now)).toEqual({ engineerIdleMs: 3_600_000, reviewQueueAgeMs: 1_800_000, redCiMs: undefined });
  });
});
