import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STARTS_PER_MINUTE,
  DEFAULT_MIN_FREE_HOST_MEMORY_MB,
  DEFAULT_RUN_MEMORY_ESTIMATE_MB,
  parseDefaultOnRunLimitValue,
  mergeRunLimits,
  normalizeRunLimits,
  parseRunLimitValue,
  patchRunLimitsSchema,
  readRunLimitsFromEnv,
  resolveRunLimits,
  runLimitsSchema,
} from "./myrmidon-runtime-limits.js";
import type { InstanceGeneralSettings } from "./types/instance.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

const STORED = {
  maxConcurrentRuns: 4,
  maxStartsPerMinute: 10,
  minFreeMemoryMb: 1500,
  runMemoryEstimateMb: 250,
  minFreeHostMemoryMb: 12288,
};

describe("myrmidon(C0) run limits: the stored value and the settings field", () => {
  it("keeps the field in the settings interface and its validator in step", () => {
    const parsed = instanceGeneralSettingsSchema.parse({ runLimits: STORED });
    // Compile-time guard: the hand-written interface and the validator must
    // agree on runLimits, or this assignment stops type-checking.
    const view: InstanceGeneralSettings = parsed;
    expect(view.runLimits).toEqual(STORED);
    expect(instanceGeneralSettingsSchema.shape.runLimits.isOptional()).toBe(true);
  });

  it("accepts only whole positive values or null, and never a missing budget", () => {
    expect(runLimitsSchema.safeParse(STORED).success).toBe(true);
    expect(runLimitsSchema.safeParse({ ...STORED, maxConcurrentRuns: null }).success).toBe(true);
    expect(runLimitsSchema.safeParse({ ...STORED, maxConcurrentRuns: 0 }).success).toBe(false);
    expect(runLimitsSchema.safeParse({ ...STORED, maxStartsPerMinute: -1 }).success).toBe(false);
    expect(runLimitsSchema.safeParse({ ...STORED, maxStartsPerMinute: 1.5 }).success).toBe(false);
    const { runMemoryEstimateMb: _dropped, ...withoutBudget } = STORED;
    expect(runLimitsSchema.safeParse(withoutBudget).success).toBe(false);
    expect(normalizeRunLimits({ maxConcurrentRuns: 0 })).toBeNull();
  });

  it("takes a patch of any subset, with null meaning 'off'", () => {
    expect(patchRunLimitsSchema.parse({ maxConcurrentRuns: null })).toEqual({ maxConcurrentRuns: null });
    expect(patchRunLimitsSchema.safeParse({ runMemoryEstimateMb: null }).success).toBe(false);
    expect(patchRunLimitsSchema.safeParse({ unknownKey: 1 }).success).toBe(false);
    expect(mergeRunLimits(STORED, { maxConcurrentRuns: 8, minFreeMemoryMb: null })).toEqual({
      maxConcurrentRuns: 8,
      maxStartsPerMinute: 10,
      minFreeMemoryMb: null,
      runMemoryEstimateMb: 250,
      minFreeHostMemoryMb: 12288,
    });
    expect(mergeRunLimits(STORED, { minFreeHostMemoryMb: null }).minFreeHostMemoryMb).toBeNull();
    expect(patchRunLimitsSchema.safeParse({ minFreeHostMemoryMb: 0 }).success).toBe(false);
  });
});

describe("myrmidon(C0) run limits: environment values and precedence", () => {
  it("reads unset, empty, zero and garbage as no limit, and defaults the budget, the ramp and the host floor", () => {
    expect(readRunLimitsFromEnv({})).toEqual({
      maxConcurrentRuns: null,
      maxStartsPerMinute: DEFAULT_MAX_STARTS_PER_MINUTE,
      minFreeMemoryMb: null,
      runMemoryEstimateMb: DEFAULT_RUN_MEMORY_ESTIMATE_MB,
      minFreeHostMemoryMb: DEFAULT_MIN_FREE_HOST_MEMORY_MB,
    });
    expect(DEFAULT_MAX_STARTS_PER_MINUTE).toBe(5);
    expect(DEFAULT_MIN_FREE_HOST_MEMORY_MB).toBe(15360);
    expect(parseRunLimitValue(" 12 ")).toBe(12);
    expect(parseRunLimitValue("0")).toBeNull();
    expect(parseRunLimitValue("-3")).toBeNull();
    expect(parseRunLimitValue("x")).toBeNull();
    expect(parseRunLimitValue(undefined)).toBeNull();
    expect(readRunLimitsFromEnv({ MYRMIDON_RUN_MEMORY_ESTIMATE_MB: "250" }).runMemoryEstimateMb).toBe(250);
  });

  it("reports the environment value as the source until settings save them", () => {
    const env = { MYRMIDON_MAX_CONCURRENT_RUNS: "8", MYRMIDON_MIN_FREE_MEMORY_MB: "1500" };
    expect(resolveRunLimits({ env })).toEqual({
      limits: {
        maxConcurrentRuns: 8,
        maxStartsPerMinute: 5,
        minFreeMemoryMb: 1500,
        runMemoryEstimateMb: 300,
        minFreeHostMemoryMb: 15360,
      },
      sources: {
        maxConcurrentRuns: "env",
        maxStartsPerMinute: "default",
        minFreeMemoryMb: "env",
        runMemoryEstimateMb: "default",
        minFreeHostMemoryMb: "default",
      },
    });
  });

  it("lets the stored settings override the environment, all at once", () => {
    const resolved = resolveRunLimits({ stored: STORED, env: { MYRMIDON_MAX_CONCURRENT_RUNS: "8" } });
    expect(resolved.limits).toEqual(STORED);
    expect(Object.values(resolved.sources)).toEqual(["settings", "settings", "settings", "settings", "settings"]);
  });

  it("falls back to the environment when the stored value is not canonical", () => {
    const resolved = resolveRunLimits({ stored: { maxConcurrentRuns: 0 }, env: { MYRMIDON_MAX_CONCURRENT_RUNS: "8" } });
    expect(resolved.limits.maxConcurrentRuns).toBe(8);
    expect(resolved.sources.maxConcurrentRuns).toBe("env");
  });
});
describe("myrmidon(1.6.2 RUN-ADMISSION) host floor and start ramp", () => {
  it("switches the default-on caps off only on an explicit off value", () => {
    for (const off of ["0", "off", "OFF", " none ", "false", "no"]) {
      expect(parseDefaultOnRunLimitValue(off, 5)).toBeNull();
    }
    expect(parseDefaultOnRunLimitValue(undefined, 5)).toBe(5);
    expect(parseDefaultOnRunLimitValue("", 5)).toBe(5);
    // A typo keeps the protection rather than silently removing it.
    expect(parseDefaultOnRunLimitValue("lots", 5)).toBe(5);
    expect(parseDefaultOnRunLimitValue("-2", 5)).toBe(5);
    expect(parseDefaultOnRunLimitValue(" 9 ", 5)).toBe(9);
    expect(
      readRunLimitsFromEnv({ MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "off", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "0" }),
    ).toMatchObject({ minFreeHostMemoryMb: null, maxStartsPerMinute: null });
  });

  it("reports an explicit environment off value as the environment source", () => {
    const resolved = resolveRunLimits({ env: { MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "off", MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "8" } });
    expect(resolved.limits).toMatchObject({ minFreeHostMemoryMb: null, maxStartsPerMinute: 8 });
    expect(resolved.sources).toMatchObject({ minFreeHostMemoryMb: "env", maxStartsPerMinute: "env" });
  });

  it("reads a row saved before the host floor existed, taking the floor from the environment", () => {
    const { minFreeHostMemoryMb: _absent, ...oldRow } = STORED;
    // The settings block must still parse: a strict miss would discard every general setting.
    expect(instanceGeneralSettingsSchema.safeParse({ runLimits: oldRow }).success).toBe(true);
    expect(normalizeRunLimits(oldRow)).toEqual({ ...oldRow, minFreeHostMemoryMb: 15360 });
    const resolved = resolveRunLimits({ stored: oldRow, env: { MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "20480" } });
    expect(resolved.limits).toEqual({ ...oldRow, minFreeHostMemoryMb: 20480 });
    expect(resolved.sources).toEqual({
      maxConcurrentRuns: "settings",
      maxStartsPerMinute: "settings",
      minFreeMemoryMb: "settings",
      runMemoryEstimateMb: "settings",
      minFreeHostMemoryMb: "env",
    });
  });
});
