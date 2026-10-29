import { describe, expect, it } from "vitest";
import {
  collectDevflowDurations,
  evaluateDevflowThresholds,
  readDevflowThresholds,
  DEFAULT_DEVFLOW_THRESHOLDS_MS,
} from "./thresholds.js";

const now = new Date("2026-10-27T20:00:00.000Z");

describe("DEVFLOW health thresholds", () => {
  it("defaults to 2h for approvedNotMerged and 6h for noMergesMs", () => {
    const thresholds = readDevflowThresholds({});
    expect(thresholds.approvedNotMergedMs).toBe(2 * 60 * 60_000);
    expect(thresholds.noMergesMs).toBe(6 * 60 * 60_000);
    expect(thresholds.engineerIdleMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.engineerIdleMs);
    expect(thresholds.reviewQueueAgeMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.reviewQueueAgeMs);
    expect(thresholds.redCiMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.redCiMs);
  });

  it("alerts at or above configured thresholds without a model call", () => {
    expect(evaluateDevflowThresholds(
      { engineerIdleMs: 10, reviewQueueAgeMs: 20, redCiMs: 30, approvedNotMergedMs: 40, noMergesMs: 50 },
      { engineerIdleMs: 10, reviewQueueAgeMs: 21, redCiMs: 30, approvedNotMergedMs: 40, noMergesMs: 50 },
    )).toEqual([
      { metric: "engineerIdleMs", durationMs: 10, thresholdMs: 10 },
      { metric: "redCiMs", durationMs: 30, thresholdMs: 30 },
      { metric: "approvedNotMergedMs", durationMs: 40, thresholdMs: 40 },
      { metric: "noMergesMs", durationMs: 50, thresholdMs: 50 },
    ]);
  });

  it("does not alert below thresholds and ignores missing values", () => {
    expect(evaluateDevflowThresholds(
      { engineerIdleMs: 9, reviewQueueAgeMs: undefined, approvedNotMergedMs: 10, noMergesMs: 20 },
      { approvedNotMergedMs: 20, noMergesMs: 30 },
    )).toEqual([]);
  });

  it("collects persisted timestamp ages including noMergesSince", () => {
    expect(collectDevflowDurations({
      engineerLastHeartbeatAt: "2026-10-27T19:00:00.000Z",
      reviewEnteredAt: "2026-10-27T19:30:00.000Z",
      ciRedSince: null,
      approvedNotMergedSince: "2026-10-27T18:00:00.000Z",
      noMergesSince: "2026-10-27T14:00:00.000Z",
    }, now)).toEqual({
      engineerIdleMs: 3_600_000,
      reviewQueueAgeMs: 1_800_000,
      redCiMs: undefined,
      approvedNotMergedMs: 7_200_000,
      noMergesMs: 21_600_000,
    });
  });
});
