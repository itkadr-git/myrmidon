import { describe, expect, it } from "vitest";
import {
  collectDevflowDurations,
  DEFAULT_DEVFLOW_THRESHOLDS_MS,
  evaluateDevflowThresholds,
  readDevflowThresholds,
} from "./thresholds.js";

const now = new Date("2026-10-27T20:00:00.000Z");

describe("DEVFLOW health thresholds", () => {
  it("defaults to 2h for approvedNotMerged, 6h for noMergesMs, and 1h for pipeline liveness metrics", () => {
    const thresholds = readDevflowThresholds({});
    expect(thresholds.approvedNotMergedMs).toBe(2 * 60 * 60_000);
    expect(thresholds.noMergesMs).toBe(6 * 60 * 60_000);
    expect(thresholds.staleMarkerMs).toBe(60 * 60_000);
    expect(thresholds.stalledMergeMs).toBe(60 * 60_000);
    expect(thresholds.stalledRouterMs).toBe(60 * 60_000);
    expect(thresholds.engineerIdleMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.engineerIdleMs);
    expect(thresholds.reviewQueueAgeMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.reviewQueueAgeMs);
    expect(thresholds.redCiMs).toBe(DEFAULT_DEVFLOW_THRESHOLDS_MS.redCiMs);
  });

  it("alerts at or above configured thresholds without a model call", () => {
    expect(
      evaluateDevflowThresholds(
        {
          engineerIdleMs: 10,
          reviewQueueAgeMs: 20,
          redCiMs: 30,
          staleMarkerMs: 40,
          stalledMergeMs: 50,
          stalledRouterMs: 60,
          approvedNotMergedMs: 70,
          noMergesMs: 80,
        },
        {
          engineerIdleMs: 10,
          reviewQueueAgeMs: 21,
          redCiMs: 30,
          staleMarkerMs: 40,
          stalledMergeMs: 51,
          stalledRouterMs: 60,
          approvedNotMergedMs: 70,
          noMergesMs: 81,
        },
      ),
    ).toEqual([
      { metric: "engineerIdleMs", durationMs: 10, thresholdMs: 10 },
      { metric: "redCiMs", durationMs: 30, thresholdMs: 30 },
      { metric: "staleMarkerMs", durationMs: 40, thresholdMs: 40 },
      { metric: "stalledRouterMs", durationMs: 60, thresholdMs: 60 },
      { metric: "approvedNotMergedMs", durationMs: 70, thresholdMs: 70 },
    ]);
  });

  it("does not alert below thresholds and ignores missing values", () => {
    expect(
      evaluateDevflowThresholds(
        {
          engineerIdleMs: 9,
          reviewQueueAgeMs: undefined,
          staleMarkerMs: 500,
          stalledMergeMs: undefined,
          stalledRouterMs: 10,
          approvedNotMergedMs: 10,
          noMergesMs: 20,
        },
        {
          staleMarkerMs: 600,
          stalledRouterMs: 20,
          approvedNotMergedMs: 20,
          noMergesMs: 30,
        },
      ),
    ).toEqual([]);
  });

  it("reads default thresholds and recognizes aliases", () => {
    const defaults = readDevflowThresholds({});
    expect(defaults).toEqual(DEFAULT_DEVFLOW_THRESHOLDS_MS);
    expect(defaults.staleMarkerMs).toBe(60 * 60_000);
    expect(defaults.stalledMergeMs).toBe(60 * 60_000);
    expect(defaults.stalledRouterMs).toBe(60 * 60_000);
    expect(defaults.approvedNotMergedMs).toBe(2 * 60 * 60_000);
    expect(defaults.noMergesMs).toBe(6 * 60 * 60_000);

    const configured = readDevflowThresholds({
      approvalMarkerMs: 120_000,
      autoMergeMs: 180_000,
      reviewRouterMs: 240_000,
    });
    expect(configured.staleMarkerMs).toBe(120_000);
    expect(configured.stalledMergeMs).toBe(180_000);
    expect(configured.stalledRouterMs).toBe(240_000);

    // Primary keys override aliases
    const overridden = readDevflowThresholds({
      staleMarkerMs: 300_000,
      approvalMarkerMs: 120_000,
    });
    expect(overridden.staleMarkerMs).toBe(300_000);
  });

  it("collects persisted timestamp ages for all stages", () => {
    expect(
      collectDevflowDurations(
        {
          engineerLastHeartbeatAt: "2026-10-27T19:00:00.000Z",
          reviewEnteredAt: "2026-10-27T19:30:00.000Z",
          ciRedSince: null,
          staleMarkerSince: "2026-10-27T19:45:00.000Z",
          stalledMergeSince: "2026-10-27T19:15:00.000Z",
          stalledRouterSince: "2026-10-27T19:50:00.000Z",
          approvedNotMergedSince: "2026-10-27T18:00:00.000Z",
          noMergesSince: "2026-10-27T14:00:00.000Z",
        },
        now,
      ),
    ).toEqual({
      engineerIdleMs: 3_600_000,
      reviewQueueAgeMs: 1_800_000,
      redCiMs: undefined,
      staleMarkerMs: 900_000,
      stalledMergeMs: 2_700_000,
      stalledRouterMs: 600_000,
      approvedNotMergedMs: 7_200_000,
      noMergesMs: 21_600_000,
    });
  });
});
