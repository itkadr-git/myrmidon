import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
  DEFAULT_RUN_STALL_PAGE_SIZE,
  DEFAULT_RUN_STALL_THRESHOLD_SEC,
  MAX_RUN_STALL_CHECK_INTERVAL_SEC,
  MAX_RUN_STALL_PAGE_SIZE,
  MAX_RUN_STALL_THRESHOLD_SEC,
  MIN_RUN_STALL_CHECK_INTERVAL_SEC,
  MIN_RUN_STALL_PAGE_SIZE,
  MIN_RUN_STALL_THRESHOLD_SEC,
  mergeRunStall,
  normalizeRunStall,
  patchRunStallSchema,
  readRunStallFromEnv,
  resolveRunStall,
  runStallSettingsSchema,
} from "./myrmidon-run-stall.js";
import type { InstanceGeneralSettings } from "./types/instance.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

const STORED = { enabled: false, thresholdSec: 300, checkIntervalSec: 30, pageSize: 10 };

describe("myrmidon(RUN-STALL-SETTINGS): the stored value and the settings field", () => {
  it("keeps the field in the settings interface and its validator in step", () => {
    const parsed = instanceGeneralSettingsSchema.parse({ runStall: STORED });
    // Compile-time guard: the hand-written interface and the validator must
    // agree on runStall, or this assignment stops type-checking.
    const view: InstanceGeneralSettings = parsed;
    expect(view.runStall).toEqual(STORED);
    expect(instanceGeneralSettingsSchema.shape.runStall.isOptional()).toBe(true);
  });

  it("accepts only whole in-range values and a boolean switch", () => {
    expect(runStallSettingsSchema.safeParse(STORED).success).toBe(true);
    expect(runStallSettingsSchema.safeParse({ ...STORED, thresholdSec: 59 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, thresholdSec: 86401 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, thresholdSec: 1.5 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, checkIntervalSec: 14 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, pageSize: 0 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, pageSize: 201 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, enabled: "off" }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ ...STORED, bogus: 1 }).success).toBe(false);
    expect(runStallSettingsSchema.safeParse({ thresholdSec: 300 }).success).toBe(false);
  });

  it("the patch takes any subset and rejects the same out-of-range values", () => {
    expect(patchRunStallSchema.safeParse({}).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ thresholdSec: MIN_RUN_STALL_THRESHOLD_SEC }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ thresholdSec: MAX_RUN_STALL_THRESHOLD_SEC }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ checkIntervalSec: MIN_RUN_STALL_CHECK_INTERVAL_SEC }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ checkIntervalSec: MAX_RUN_STALL_CHECK_INTERVAL_SEC }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ pageSize: MIN_RUN_STALL_PAGE_SIZE }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ pageSize: MAX_RUN_STALL_PAGE_SIZE }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(patchRunStallSchema.safeParse({ thresholdSec: 0 }).success).toBe(false);
    expect(patchRunStallSchema.safeParse({ thresholdSec: null }).success).toBe(false);
    expect(patchRunStallSchema.safeParse({ pageSize: 1000 }).success).toBe(false);
  });
});

describe("myrmidon(RUN-STALL-SETTINGS): resolution and precedence", () => {
  it("reads the environment with the run-stall reader semantics", () => {
    expect(readRunStallFromEnv({})).toEqual({
      enabled: true,
      thresholdSec: DEFAULT_RUN_STALL_THRESHOLD_SEC,
      checkIntervalSec: DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
      pageSize: DEFAULT_RUN_STALL_PAGE_SIZE,
    });
    expect(
      readRunStallFromEnv({
        MYRMIDON_RUN_STALL_ENABLED: "off",
        MYRMIDON_RUN_STALL_THRESHOLD_SEC: "600",
        MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC: "30",
        MYRMIDON_RUN_STALL_PAGE_SIZE: "100",
      }),
    ).toEqual({ enabled: false, thresholdSec: 600, checkIntervalSec: 30, pageSize: 100 });
    // A typo never silently extinguishes the fix; out-of-range numbers fall back.
    expect(
      readRunStallFromEnv({
        MYRMIDON_RUN_STALL_ENABLED: "proably",
        MYRMIDON_RUN_STALL_THRESHOLD_SEC: "30",
        MYRMIDON_RUN_STALL_CHECK_INTERVAL_SEC: "abc",
        MYRMIDON_RUN_STALL_PAGE_SIZE: "500",
      }),
    ).toEqual({
      enabled: true,
      thresholdSec: DEFAULT_RUN_STALL_THRESHOLD_SEC,
      checkIntervalSec: DEFAULT_RUN_STALL_CHECK_INTERVAL_SEC,
      pageSize: DEFAULT_RUN_STALL_PAGE_SIZE,
    });
  });

  it("the stored value wins over the environment, an unreadable row counts as absent", () => {
    const resolved = resolveRunStall({
      stored: STORED,
      env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "900", MYRMIDON_RUN_STALL_ENABLED: "off" },
    });
    expect(resolved.settings).toEqual(STORED);
    expect(resolved.sources).toEqual({
      enabled: "settings",
      thresholdSec: "settings",
      checkIntervalSec: "settings",
      pageSize: "settings",
    });

    const fromEnv = resolveRunStall({ stored: { thresholdSec: "loud" }, env: { MYRMIDON_RUN_STALL_THRESHOLD_SEC: "900" } });
    expect(fromEnv.settings.thresholdSec).toBe(900);
    expect(fromEnv.sources.thresholdSec).toBe("env");
    expect(fromEnv.sources.pageSize).toBe("default");
  });

  it("merges a patch over the effective values", () => {
    const base = readRunStallFromEnv({});
    expect(mergeRunStall(base, { thresholdSec: 300 })).toEqual({ ...base, thresholdSec: 300 });
    expect(mergeRunStall(base, {})).toEqual(base);
  });

  it("normalizeRunStall rejects anything but the canonical stored shape", () => {
    expect(normalizeRunStall(STORED)).toEqual(STORED);
    expect(normalizeRunStall(undefined)).toBeNull();
    expect(normalizeRunStall(null)).toBeNull();
    expect(normalizeRunStall({ ...STORED, thresholdSec: 1 })).toBeNull();
    expect(normalizeRunStall({ thresholdSec: 300 })).toBeNull();
  });
});
