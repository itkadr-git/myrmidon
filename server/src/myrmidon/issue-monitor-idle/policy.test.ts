import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT,
  decideIdleMonitor,
  resolveMonitorUnchangedWakeLimit,
} from "./policy.js";

const NOW = new Date("2026-11-14T20:00:00.000Z");

describe("resolveMonitorUnchangedWakeLimit", () => {
  it("defaults to three and reads general.processes", () => {
    expect(DEFAULT_MONITOR_UNCHANGED_WAKE_LIMIT).toBe(3);
    expect(resolveMonitorUnchangedWakeLimit({})).toBe(3);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: 5 } })).toBe(5);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: 5 }, behaviorSettings: { monitorUnchangedWakeLimit: 2 } })).toBe(2);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: "2" } })).toBe(2);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: 0 } })).toBe(0);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: "x" } })).toBe(3);
    expect(resolveMonitorUnchangedWakeLimit({ processes: { monitorUnchangedWakeLimit: 1000 } })).toBe(100);
  });
});

describe("decideIdleMonitor", () => {
  const previous = (snapshotHash: string, unchangedCount: number) => ({ snapshotHash, unchangedCount });

  it("wakes when there is no recorded wake or the snapshot changed", () => {
    expect(decideIdleMonitor({ now: NOW, snapshotHash: "a", previous: null, limit: 3 })).toEqual({ action: "wake" });
    expect(decideIdleMonitor({ now: NOW, snapshotHash: "b", previous: previous("a", 2), limit: 3 })).toEqual({
      action: "wake",
    });
  });

  it("defers with a growing interval while unchanged, then clears at the limit", () => {
    const first = decideIdleMonitor({ now: NOW, snapshotHash: "a", previous: previous("a", 0), limit: 3 });
    expect(first).toMatchObject({ action: "defer", unchangedCount: 1 });
    expect(first.action === "defer" && first.nextCheckAt.toISOString()).toBe("2026-11-14T20:10:00.000Z");
    const second = decideIdleMonitor({ now: NOW, snapshotHash: "a", previous: previous("a", 1), limit: 3 });
    expect(second.action === "defer" && second.nextCheckAt.toISOString()).toBe("2026-11-14T20:20:00.000Z");
    expect(decideIdleMonitor({ now: NOW, snapshotHash: "a", previous: previous("a", 2), limit: 3 })).toEqual({
      action: "clear",
      unchangedCount: 3,
    });
  });

  it("is off with a limit of zero", () => {
    expect(decideIdleMonitor({ now: NOW, snapshotHash: "a", previous: previous("a", 9), limit: 0 })).toEqual({
      action: "wake",
    });
  });
});
