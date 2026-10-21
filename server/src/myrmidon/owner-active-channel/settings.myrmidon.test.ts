// myrmidon(1.7-ACTIVE-CHANNEL): the settings reader — short cache of the
// stored row, forced environment override re-read every call, a read failure
// falls back without throwing, and the preserve helper that keeps our key
// across vendor writes of `instance_settings.general`.
import { describe, expect, it } from "vitest";
import {
  OWNER_ACTIVE_CHANNEL_SETTINGS_KEY,
  OWNER_ACTIVE_THRESHOLD_ENV,
} from "@paperclipai/shared";
import {
  invalidateOwnerActiveChannelSettingsCache,
  readOwnerActiveChannelSettings,
} from "./settings.js";

function deps(options: {
  general?: () => Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => number;
  cacheMs?: number;
}) {
  return {
    getGeneral: options.general ?? (async () => ({ [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: { thresholdMin: 45 } })),
    env: options.env ?? {},
    now: options.now,
    cacheMs: options.cacheMs,
  };
}

describe("readOwnerActiveChannelSettings", () => {
  it("reads the stored value and caches it for the window", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    let reads = 0;
    const reader = deps({
      general: async () => {
        reads += 1;
        return { [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: { thresholdMin: 45 } };
      },
      now: () => 1_000,
      cacheMs: 5_000,
    });
    expect(await readOwnerActiveChannelSettings(reader)).toEqual({
      thresholdMin: 45,
      thresholdSource: "settings",
    });
    expect(await readOwnerActiveChannelSettings(reader)).toEqual({
      thresholdMin: 45,
      thresholdSource: "settings",
    });
    expect(reads).toBe(1);
    // The clock moves past the window: the row is read again.
    const reader2 = { ...reader, now: () => 7_000 };
    expect((await readOwnerActiveChannelSettings(reader2)).thresholdMin).toBe(45);
    expect(reads).toBe(2);
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("the environment override applies without waiting for the cache", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    let reads = 0;
    const reader = deps({
      general: async () => {
        reads += 1;
        return { [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: { thresholdMin: 45 } };
      },
      env: { [OWNER_ACTIVE_THRESHOLD_ENV]: "10" },
      now: () => 1_000,
    });
    expect(await readOwnerActiveChannelSettings(reader)).toEqual({
      thresholdMin: 10,
      thresholdSource: "env",
    });
    expect(await readOwnerActiveChannelSettings(reader)).toEqual({
      thresholdMin: 10,
      thresholdSource: "env",
    });
    // The first read warmed the cache; the override still wins on both.
    expect(reads).toBeLessThanOrEqual(1);
    invalidateOwnerActiveChannelSettingsCache();
  });

  it("a settings read failure falls back to the default and never throws", async () => {
    invalidateOwnerActiveChannelSettingsCache();
    const reader = deps({ general: async () => { throw new Error("db down"); } });
    expect(await readOwnerActiveChannelSettings(reader)).toEqual({
      thresholdMin: 120,
      thresholdSource: "default",
    });
    invalidateOwnerActiveChannelSettingsCache();
  });
});

describe("preserveOwnerActiveChannelGeneralKey", () => {
  it("restores the stored key only when it exists", async () => {
    const { preserveOwnerActiveChannelGeneralKey } = await import("./settings.js");
    expect(
      preserveOwnerActiveChannelGeneralKey({ [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: { thresholdMin: 45 } }),
    ).toEqual({ [OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]: { thresholdMin: 45 } });
    expect(preserveOwnerActiveChannelGeneralKey({ other: 1 })).toEqual({});
    expect(preserveOwnerActiveChannelGeneralKey(null)).toEqual({});
  });
});
