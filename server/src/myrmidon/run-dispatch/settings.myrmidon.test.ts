import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
  MIN_QUEUED_RUN_STALE_AFTER_SEC,
  resolveRunDispatchSettings,
} from "./settings.js";

describe("resolveRunDispatchSettings (OPE-12291 queue-stale floor)", () => {
  it("keeps the default when no processes record exists", () => {
    expect(resolveRunDispatchSettings({})).toEqual({
      runStartDispatch: "inline",
      queuedResweepSec: 30,
      queuedRunStaleAfterSec: DEFAULT_QUEUED_RUN_STALE_AFTER_SEC,
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
});
