import { describe, expect, it } from "vitest";
import {
  idleStopModeSchema,
  idleStopSettingsSchema,
  normalizeIdleStopSettings,
  mergeIdleStopSettings,
} from "./myrmidon-idle-stop.js";

describe("idleStopModeSchema (OPE-12291)", () => {
  it("accepts on_demand, always_on and off", () => {
    for (const mode of ["on_demand", "always_on", "off"] as const) {
      expect(idleStopModeSchema.parse(mode)).toBe(mode);
    }
  });

  it("rejects unknown modes", () => {
    expect(idleStopModeSchema.safeParse("sometimes").success).toBe(false);
  });
});

describe("idleStopSettingsSchema alwaysOnRoles (OPE-12291)", () => {
  it("accepts a valid alwaysOnRoles list", () => {
    const parsed = idleStopSettingsSchema.parse({
      enabled: true,
      afterSec: 1800,
      healthTimeoutMs: 420000,
      alwaysOnRoles: ["lead"],
    });
    expect(parsed.alwaysOnRoles).toEqual(["lead"]);
  });

  it("treats alwaysOnRoles as optional", () => {
    const parsed = idleStopSettingsSchema.parse({
      enabled: true,
      afterSec: 1800,
      healthTimeoutMs: 420000,
    });
    expect(parsed.alwaysOnRoles).toBeUndefined();
  });

  it("rejects an empty role string", () => {
    expect(
      idleStopSettingsSchema.safeParse({
        enabled: true,
        afterSec: 1800,
        healthTimeoutMs: 420000,
        alwaysOnRoles: [""],
      }).success,
    ).toBe(false);
  });
});

describe("normalizeIdleStopSettings alwaysOnRoles default (OPE-12291)", () => {
  it("defaults alwaysOnRoles to [\"lead\"] when not stored", () => {
    const normalized = normalizeIdleStopSettings({}, {});
    expect(normalized.alwaysOnRoles).toEqual(["lead"]);
  });

  it("keeps an explicit stored list, including empty", () => {
    expect(
      normalizeIdleStopSettings(
        { enabled: true, afterSec: 1800, healthTimeoutMs: 420000, alwaysOnRoles: ["ops"] },
        {},
      ).alwaysOnRoles,
    ).toEqual(["ops"]);
    expect(
      normalizeIdleStopSettings(
        { enabled: true, afterSec: 1800, healthTimeoutMs: 420000, alwaysOnRoles: [] },
        {},
      ).alwaysOnRoles,
    ).toEqual([]);
  });

  it("mergeIdleStopSettings keeps the default when the patch omits alwaysOnRoles", () => {
    const merged = mergeIdleStopSettings({}, { enabled: false }, {});
    expect(merged.alwaysOnRoles).toEqual(["lead"]);
  });
});
