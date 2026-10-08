import { describe, expect, it } from "vitest";

import {
  DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC,
  DEFAULT_FALLBACK_SIGNAL_MIN_CALLS,
  DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT,
  DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC,
  FALLBACK_SIGNAL_SETTINGS_KEY,
  fallbackSignalIntervalMs,
  fallbackSignalSettingsSchema,
  fallbackSignalWindowMs,
  mergeFallbackSignalSettings,
  normalizeFallbackSignalSettings,
  parseFallbackSignalEnabled,
  patchFallbackSignalSettingsSchema,
  readFallbackSignalSettingsFromEnv,
  resolveFallbackSignalSettings,
} from "./myrmidon-fallback-signal.js";

const STORED = {
  enabled: true,
  thresholdPct: 35,
  minCalls: 5,
  windowSec: 7200,
  intervalSec: 120,
};

describe("myrmidon(BOT-RUNTIME-TUNING D2) settings contract", () => {
  it("names one stored key and the environment variables of the deployment", () => {
    expect(FALLBACK_SIGNAL_SETTINGS_KEY).toBe("modelFallbackSignal");
  });

  it("keeps the deployment semantics of the environment variables", () => {
    // The reader the sweep used before the stored settings existed: an
    // unreadable value falls back to the default, an out-of-range number is
    // clamped into range.
    const settings = readFallbackSignalSettingsFromEnv({
      MYRMIDON_MODEL_FALLBACK_ENABLED: "1",
      MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT: "0",
      MYRMIDON_MODEL_FALLBACK_MIN_CALLS: "-5",
      MYRMIDON_MODEL_FALLBACK_WINDOW_SEC: "1",
      MYRMIDON_MODEL_FALLBACK_INTERVAL_SEC: "not-a-number",
    });
    expect(settings).toEqual({
      enabled: true,
      thresholdPct: 1,
      minCalls: 1,
      windowSec: 300,
      intervalSec: DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC,
    });
  });

  it("defaults to off with the briefed numbers when nothing is set", () => {
    expect(readFallbackSignalSettingsFromEnv({})).toEqual({
      enabled: false,
      thresholdPct: DEFAULT_FALLBACK_SIGNAL_THRESHOLD_PCT,
      minCalls: DEFAULT_FALLBACK_SIGNAL_MIN_CALLS,
      windowSec: DEFAULT_FALLBACK_SIGNAL_WINDOW_SEC,
      intervalSec: DEFAULT_FALLBACK_SIGNAL_INTERVAL_SEC,
    });
    expect(parseFallbackSignalEnabled("yes")).toBeNull();
    expect(parseFallbackSignalEnabled("TRUE")).toBe(true);
    expect(parseFallbackSignalEnabled("0")).toBe(false);
  });

  it("takes the stored settings as the source of truth and reports it", () => {
    const resolved = resolveFallbackSignalSettings({ stored: STORED, env: {} });
    expect(resolved.settings).toEqual(STORED);
    expect(resolved.sources).toEqual({
      enabled: "settings",
      thresholdPct: "settings",
      minCalls: "settings",
      windowSec: "settings",
      intervalSec: "settings",
    });
  });

  it("lets a set environment variable override the stored value key by key", () => {
    const resolved = resolveFallbackSignalSettings({
      stored: STORED,
      env: { MYRMIDON_MODEL_FALLBACK_THRESHOLD_PCT: "50", MYRMIDON_MODEL_FALLBACK_ENABLED: "" },
    });
    expect(resolved.settings.thresholdPct).toBe(50);
    expect(resolved.settings.windowSec).toBe(STORED.windowSec);
    // An empty override is not an override: the stored value still wins.
    expect(resolved.settings.enabled).toBe(true);
    expect(resolved.sources).toEqual({
      enabled: "settings",
      thresholdPct: "env",
      minCalls: "settings",
      windowSec: "settings",
      intervalSec: "settings",
    });
  });

  it("ignores an unusable stored row instead of arming the sweep on it", () => {
    expect(normalizeFallbackSignalSettings({ enabled: true })).toBeNull();
    expect(normalizeFallbackSignalSettings({ ...STORED, thresholdPct: 0 })).toBeNull();
    expect(normalizeFallbackSignalSettings({ ...STORED, extra: 1 })).toBeNull();
    const resolved = resolveFallbackSignalSettings({ stored: { enabled: true }, env: {} });
    expect(resolved.settings.enabled).toBe(false);
    expect(resolved.sources.enabled).toBe("default");
  });

  it("validates a patch without requiring the untouched keys", () => {
    expect(patchFallbackSignalSettingsSchema.safeParse({ thresholdPct: 25 }).success).toBe(true);
    expect(patchFallbackSignalSettingsSchema.safeParse({ thresholdPct: 0 }).success).toBe(false);
    expect(patchFallbackSignalSettingsSchema.safeParse({ windowSec: 60 }).success).toBe(false);
    expect(patchFallbackSignalSettingsSchema.safeParse({ unknown: 1 }).success).toBe(false);
    expect(fallbackSignalSettingsSchema.safeParse(STORED).success).toBe(true);
  });

  it("merges a patch over the effective values", () => {
    expect(mergeFallbackSignalSettings(STORED, { thresholdPct: 10 })).toEqual({
      ...STORED,
      thresholdPct: 10,
    });
    expect(mergeFallbackSignalSettings(STORED, {})).toEqual(STORED);
  });

  it("converts the stored seconds into the units the sweep works in", () => {
    expect(fallbackSignalWindowMs(STORED)).toBe(7_200_000);
    expect(fallbackSignalIntervalMs(STORED)).toBe(120_000);
  });
});