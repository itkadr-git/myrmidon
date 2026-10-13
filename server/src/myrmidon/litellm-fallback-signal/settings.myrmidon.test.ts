import { beforeEach, describe, expect, it } from "vitest";

import { FALLBACK_SIGNAL_SETTINGS_KEY } from "@paperclipai/shared";
import {
  preserveFallbackSignalGeneralKey,
  readResolvedFallbackSignalSettings,
  readStoredFallbackSignalSettings,
  updateFallbackSignalSettings,
  type FallbackSignalSettingsService,
} from "./settings.js";

// Neutral values only: no real hosts, keys or companies.

function fakeSettingsService(initial: Record<string, unknown> = {}) {
  let general: Record<string, unknown> = { ...initial };
  const service = {
    getGeneral: async () => general,
    updateGeneral: async (patch: Record<string, unknown>) => {
      general = { ...general, ...patch };
      return general;
    },
  };
  return {
    service: service as unknown as FallbackSignalSettingsService,
    general: () => general,
  };
}

const STORED = {
  enabled: true,
  thresholdPct: 35,
  minCalls: 5,
  windowSec: 7200,
  intervalSec: 120,
};

let fake: ReturnType<typeof fakeSettingsService>;

beforeEach(() => {
  fake = fakeSettingsService({ [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED, keepMe: 1 });
});

describe("myrmidon(BOT-RUNTIME-TUNING D2) settings store", () => {
  it("reads the key out of the general row", async () => {
    await expect(readStoredFallbackSignalSettings(fake.service)).resolves.toEqual(STORED);
  });

  it("reports the stored row as the source when the environment says nothing", async () => {
    const resolved = await readResolvedFallbackSignalSettings(fake.service, {});
    expect(resolved.settings).toEqual(STORED);
    expect(resolved.sources.thresholdPct).toBe("settings");
  });

  it("falls back to the environment and then to the defaults", async () => {
    const empty = fakeSettingsService();
    const fromEnv = await readResolvedFallbackSignalSettings(empty.service, {
      MYRMIDON_MODEL_FALLBACK_ENABLED: "1",
      MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT: "45",
    });
    expect(fromEnv.settings.enabled).toBe(true);
    expect(fromEnv.settings.thresholdPct).toBe(45);
    expect(fromEnv.sources.thresholdPct).toBe("env");
    expect(fromEnv.sources.windowSec).toBe("default");

    const bare = await readResolvedFallbackSignalSettings(empty.service, {});
    expect(bare.settings).toMatchObject({ enabled: false, thresholdPct: 20, minCalls: 20, windowSec: 3600 });
    expect(bare.sources.enabled).toBe("default");
  });

  it("stores a patch merged over the effective values and leaves other keys alone", async () => {
    const resolved = await updateFallbackSignalSettings(fake.service, { thresholdPct: 10 }, {});
    expect(resolved.settings).toMatchObject({ ...STORED, thresholdPct: 10 });
    expect(fake.general()).toMatchObject({
      keepMe: 1,
      [FALLBACK_SIGNAL_SETTINGS_KEY]: { ...STORED, thresholdPct: 10 },
    });
  });

  it("keeps reporting an environment override after the write", async () => {
    const resolved = await updateFallbackSignalSettings(
      fake.service,
      { thresholdPct: 10 },
      { MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT: "50" },
    );
    // The stored object carries the operator's number, the environment wins the
    // resolution and says so — the same precedence every other setting shows.
    expect(resolved.settings.thresholdPct).toBe(50);
    expect(resolved.sources.thresholdPct).toBe("env");
    expect(fake.general()).toMatchObject({
      [FALLBACK_SIGNAL_SETTINGS_KEY]: { ...STORED, thresholdPct: 10 },
    });
  });

  it("rejects a patch outside the documented ranges", async () => {
    await expect(updateFallbackSignalSettings(fake.service, { thresholdPct: 0 }, {})).rejects.toThrow();
    await expect(updateFallbackSignalSettings(fake.service, { windowSec: 60 }, {})).rejects.toThrow();
  });

  it("preserves the stored key across a vendor write of general", () => {
    expect(preserveFallbackSignalGeneralKey({ keepMe: 1, [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED })).toEqual({
      [FALLBACK_SIGNAL_SETTINGS_KEY]: STORED,
    });
    expect(preserveFallbackSignalGeneralKey({ keepMe: 1 })).toEqual({});
    expect(preserveFallbackSignalGeneralKey(null)).toEqual({});
  });
});