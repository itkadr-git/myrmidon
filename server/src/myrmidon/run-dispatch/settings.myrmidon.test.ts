import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
  DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT,
  MIN_QUEUED_RUN_STALE_AFTER_SEC,
  resolveRunDispatchSettings,
} from "./settings.js";

describe("resolveRunDispatchSettings (OPE-12291 queue-stale floor)", () => {
  it("keeps the default when no processes record exists", () => {
    expect(resolveRunDispatchSettings({})).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
      queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
      taskRunsWithoutCommitLimit: DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT,
    });
  });

  it("clamps queuedRunStaleAfterSec to the cold-start floor (300 s)", () => {
    const resolved = resolveRunDispatchSettings({
      processes: { queuedRunStaleAfterSec: 60 },
    });
    expect(resolved.queuedRunStaleAfterSec).toBe(MIN_QUEUED_RUN_STALE_AFTER_SEC);
  });

  it("accepts values at or above the floor", () => {
    expect(
      resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: 300 } }).queuedRunStaleAfterSec,
    ).toBe(300);
    expect(
      resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: 1800 } }).queuedRunStaleAfterSec,
    ).toBe(1800);
  });

  it("clamps to the ceiling (604800)", () => {
    expect(
      resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: 999999 } }).queuedRunStaleAfterSec,
    ).toBe(604800);
  });

  it("parses a string value and clamps it to the floor", () => {
    expect(
      resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: "120" } }).queuedRunStaleAfterSec,
    ).toBe(MIN_QUEUED_RUN_STALE_AFTER_SEC);
  });

  it("falls back to the default for non-numeric values", () => {
    expect(
      resolveRunDispatchSettings({ processes: { queuedRunStaleAfterSec: "abc" } }).queuedRunStaleAfterSec,
    ).toBe(DEFAULT_QUEUED_RUN_STALE_AFTER_SEC);
  });

  it("handles taskRunsWithoutCommitLimit correctly (0 allows disabling, clamps >100, default 4)", () => {
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: 0 } }).taskRunsWithoutCommitLimit,
    ).toBe(0);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: "0" } }).taskRunsWithoutCommitLimit,
    ).toBe(0);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: -5 } }).taskRunsWithoutCommitLimit,
    ).toBe(0);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: 10 } }).taskRunsWithoutCommitLimit,
    ).toBe(10);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: "15" } }).taskRunsWithoutCommitLimit,
    ).toBe(15);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: 500 } }).taskRunsWithoutCommitLimit,
    ).toBe(100);
    expect(
      resolveRunDispatchSettings({ processes: { taskRunsWithoutCommitLimit: "invalid" } }).taskRunsWithoutCommitLimit,
    ).toBe(DEFAULT_TASK_RUNS_WITHOUT_COMMIT_LIMIT);
  });
});
