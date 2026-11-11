// myrmidon(1.7-REBRAND-F): the vendor-name gate setting — defaults, the
// environment override, and the precedence the panel and the API render.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VENDOR_NAME_CHECK_BASELINE,
  DEFAULT_VENDOR_NAME_CHECK_MODE,
  MAX_VENDOR_NAME_CHECK_BASELINE,
  VENDOR_NAME_CHECK_BASELINE_ENV,
  VENDOR_NAME_CHECK_MODE_ENV,
  mergeVendorNameCheckSettings,
  normalizeVendorNameCheckSettings,
  readVendorNameCheckEnvOverride,
  resolveVendorNameCheckSettings,
} from "./myrmidon-vendor-name.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

describe("normalizeVendorNameCheckSettings", () => {
  it("reads the stored pair, fills the absent key with its default and refuses junk", () => {
    expect(normalizeVendorNameCheckSettings({ mode: "strict", baseline: 7 })).toEqual({
      mode: "strict",
      baseline: 7,
    });
    expect(normalizeVendorNameCheckSettings({ mode: "strict" })).toEqual({
      mode: "strict",
      baseline: DEFAULT_VENDOR_NAME_CHECK_BASELINE,
    });
    // Nothing usable stored: the resolver must fall through to the default.
    expect(normalizeVendorNameCheckSettings(undefined)).toBeNull();
    expect(normalizeVendorNameCheckSettings({})).toBeNull();
    expect(normalizeVendorNameCheckSettings({ mode: "maybe" })).toBeNull();
    expect(normalizeVendorNameCheckSettings({ baseline: -1 })).toBeNull();
    expect(normalizeVendorNameCheckSettings({ baseline: MAX_VENDOR_NAME_CHECK_BASELINE + 1 })).toBeNull();
    expect(normalizeVendorNameCheckSettings("strict")).toBeNull();
  });

  it("ignores keys a newer build wrote instead of failing the whole general block", () => {
    expect(normalizeVendorNameCheckSettings({ mode: "ratchet", baseline: 3, future: true })).toEqual({
      mode: "ratchet",
      baseline: 3,
    });
  });
});

describe("readVendorNameCheckEnvOverride", () => {
  it("only counts a value that actually parses: a typo is not an override", () => {
    expect(readVendorNameCheckEnvOverride({})).toEqual({});
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_MODE_ENV]: "strict" })).toEqual({
      mode: "strict",
    });
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_MODE_ENV]: " strict " })).toEqual({
      mode: "strict",
    });
    // The value is matched exactly, like the gate's own --mode flag: a
    // capitalised spelling is not the value the gate would accept.
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_MODE_ENV]: "Strict" })).toEqual({});
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_MODE_ENV]: "maybe" })).toEqual({});
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_MODE_ENV]: "" })).toEqual({});
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_BASELINE_ENV]: "12" })).toEqual({
      baseline: 12,
    });
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_BASELINE_ENV]: "twelve" })).toEqual({});
    expect(readVendorNameCheckEnvOverride({ [VENDOR_NAME_CHECK_BASELINE_ENV]: "-2" })).toEqual({});
  });
});

describe("resolveVendorNameCheckSettings", () => {
  it("defaults to the ratchet mode against zero when nothing is stored and nothing is set", () => {
    expect(resolveVendorNameCheckSettings()).toEqual({
      settings: { mode: DEFAULT_VENDOR_NAME_CHECK_MODE, baseline: DEFAULT_VENDOR_NAME_CHECK_BASELINE },
      sources: { mode: "default", baseline: "default" },
    });
  });

  it("reports the stored value as the source when the operator saved one", () => {
    expect(resolveVendorNameCheckSettings({ stored: { mode: "strict", baseline: 4 } })).toEqual({
      settings: { mode: "strict", baseline: 4 },
      sources: { mode: "settings", baseline: "settings" },
    });
  });

  it("lets a parseable environment override win, key by key", () => {
    const resolved = resolveVendorNameCheckSettings({
      stored: { mode: "strict", baseline: 4 },
      env: { [VENDOR_NAME_CHECK_MODE_ENV]: "ratchet" },
    });
    expect(resolved.settings).toEqual({ mode: "ratchet", baseline: 4 });
    expect(resolved.sources).toEqual({ mode: "env", baseline: "settings" });
  });

  it("never reports env as the source for a value the gate would ignore", () => {
    const resolved = resolveVendorNameCheckSettings({
      stored: { mode: "strict", baseline: 4 },
      env: { [VENDOR_NAME_CHECK_MODE_ENV]: "strictest", [VENDOR_NAME_CHECK_BASELINE_ENV]: "many" },
    });
    expect(resolved.settings).toEqual({ mode: "strict", baseline: 4 });
    expect(resolved.sources).toEqual({ mode: "settings", baseline: "settings" });
  });

  it("falls back to the default per key when only the environment is set", () => {
    const resolved = resolveVendorNameCheckSettings({
      env: { [VENDOR_NAME_CHECK_BASELINE_ENV]: "9" },
    });
    expect(resolved.settings).toEqual({ mode: "ratchet", baseline: 9 });
    expect(resolved.sources).toEqual({ mode: "default", baseline: "env" });
  });
});

describe("mergeVendorNameCheckSettings", () => {
  it("merges onto the stored value, keeping the key the patch does not carry", () => {
    expect(mergeVendorNameCheckSettings({ mode: "strict", baseline: 4 }, { baseline: 11 })).toEqual({
      mode: "strict",
      baseline: 11,
    });
    expect(mergeVendorNameCheckSettings(null, { mode: "strict" })).toEqual({
      mode: "strict",
      baseline: DEFAULT_VENDOR_NAME_CHECK_BASELINE,
    });
    expect(mergeVendorNameCheckSettings(null, {})).toEqual({
      mode: DEFAULT_VENDOR_NAME_CHECK_MODE,
      baseline: DEFAULT_VENDOR_NAME_CHECK_BASELINE,
    });
  });
});

describe("the stored setting inside the general block", () => {
  it("accepts the pair, an empty patch and an absent key", () => {
    const parsed = instanceGeneralSettingsSchema.safeParse({
      vendorNameCheck: { mode: "strict", baseline: 5 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.vendorNameCheck).toEqual({ mode: "strict", baseline: 5 });

    expect(instanceGeneralSettingsSchema.safeParse({}).success).toBe(true);
    expect(instanceGeneralSettingsSchema.safeParse({ vendorNameCheck: {} }).success).toBe(true);
  });
});