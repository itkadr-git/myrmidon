import { z } from "zod";

/**
 * The vendor-name gate as an instance setting (myrmidon 1.7, REBRAND F).
 *
 * The gate itself lives in the repository
 * (`scripts/myrmidon/vendor-name/check-vendor-name.mjs`): it reads the built UI
 * bundle and the recorded response bodies of the main endpoints and counts the
 * visible vendor name (`\bPaperclip\b`). The rebrand leaves that name only in
 * the LICENSE, the third-party notices and the "based on … (MIT)" line of
 * About, so the count may not grow (ratchet) and must reach the exception
 * allowance once REBRAND A and REBRAND B have merged (strict).
 *
 * This module is the shared half: the shape of the setting, its defaults, and
 * the precedence the settings page and the API render — the stored instance
 * settings value, then the environment override, then the built-in default:
 *
 * - `mode` — `ratchet` (the visible count may not grow above `baseline`) or
 *   `strict` (no visible occurrence outside the policy's exceptions);
 * - `baseline` — the ratchet ceiling the instance reports against.
 *
 * The rule itself (tokens, exceptions, baselines) is NOT here: it stays in the
 * repository policy file, so CI, a developer run and the panel read one and the
 * same rule instead of three copies of it.
 */

/** Stored-settings key inside `instance_settings.general`. */
export const VENDOR_NAME_CHECK_SETTINGS_KEY = "vendorNameCheck";

/** The two modes of the gate. */
export const VENDOR_NAME_CHECK_MODES = ["ratchet", "strict"] as const;

export type VendorNameCheckMode = (typeof VENDOR_NAME_CHECK_MODES)[number];

/** Built-in mode while the rebrand is incomplete: the count may not grow. */
export const DEFAULT_VENDOR_NAME_CHECK_MODE: VendorNameCheckMode = "ratchet";

/** Built-in baseline of the instance report: the count it records itself. */
export const DEFAULT_VENDOR_NAME_CHECK_BASELINE = 0;

/** Ceiling of the ratchet baseline: a count of occurrences, not a budget. */
export const MAX_VENDOR_NAME_CHECK_BASELINE = 100000;

/** Environment override of the mode — a forced contour, not the normal path. */
export const VENDOR_NAME_CHECK_MODE_ENV = "MYRMIDON_VENDOR_NAME_CHECK_MODE";

/** Environment override of the baseline. */
export const VENDOR_NAME_CHECK_BASELINE_ENV = "MYRMIDON_VENDOR_NAME_CHECK_BASELINE";

const modeSchema = z.enum(VENDOR_NAME_CHECK_MODES);

const baselineSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_VENDOR_NAME_CHECK_BASELINE);

/**
 * The stored shape, lenient on purpose: a row written by an older or a newer
 * build (an unknown key, a value the validator refuses) must not fail the whole
 * general block — the resolver falls back instead, key by key.
 */
export const vendorNameCheckSettingsSchema = z
  .object({
    mode: modeSchema.optional(),
    baseline: baselineSchema.optional(),
  })
  .passthrough();

/**
 * The stored shape as the schema sees it. The instance general settings type
 * carries THIS shape (like the other lenient `stored*Settings` keys), because a
 * row written by another build may have either key absent; the resolver turns it
 * into the effective pair below.
 */
export type StoredVendorNameCheckSettings = z.infer<typeof vendorNameCheckSettingsSchema>;

/** Body of `PATCH /api/myrmidon/vendor-name-check`: any subset; absent keys keep their value. */
export const patchVendorNameCheckSettingsSchema = z
  .object({
    mode: modeSchema.optional(),
    baseline: baselineSchema.optional(),
  })
  .strict();

export type VendorNameCheckSettings = {
  mode: VendorNameCheckMode;
  baseline: number;
};

export type VendorNameCheckSettingsPatch = z.infer<typeof patchVendorNameCheckSettingsSchema>;

/** Alias, the name the routes and the service use (same shape). */
export type VendorNameCheckPatch = VendorNameCheckSettingsPatch;

/** Alias of the PATCH body schema, the name the routes validate with. */
export const patchVendorNameCheckSchema = patchVendorNameCheckSettingsSchema;

export const VENDOR_NAME_CHECK_SETTING_KEYS = ["mode", "baseline"] as const;

export type VendorNameCheckSettingKey = (typeof VENDOR_NAME_CHECK_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type VendorNameCheckSettingSource = "settings" | "env" | "default";

export interface ResolvedVendorNameCheckSettings {
  settings: VendorNameCheckSettings;
  sources: Record<VendorNameCheckSettingKey, VendorNameCheckSettingSource>;
}

/** Reads the stored object; an unusable value is "nothing was stored". */
export function normalizeVendorNameCheckSettings(raw: unknown): VendorNameCheckSettings | null {
  const parsed = vendorNameCheckSettingsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const mode = parsed.data.mode;
  const baseline = parsed.data.baseline;
  if (mode === undefined && baseline === undefined) return null;
  return {
    mode: mode ?? DEFAULT_VENDOR_NAME_CHECK_MODE,
    baseline: baseline ?? DEFAULT_VENDOR_NAME_CHECK_BASELINE,
  };
}

/**
 * Reads the environment override. A value that does not parse is NOT an
 * override: the resolver must never report "Environment override" for a
 * variable the gate would ignore (a typo would otherwise look effective).
 */
export function readVendorNameCheckEnvOverride(env: Record<string, string | undefined>): {
  mode?: VendorNameCheckMode;
  baseline?: number;
} {
  const override: { mode?: VendorNameCheckMode; baseline?: number } = {};
  const rawMode = env[VENDOR_NAME_CHECK_MODE_ENV];
  if (rawMode !== undefined && String(rawMode).trim() !== "") {
    const parsed = modeSchema.safeParse(String(rawMode).trim());
    if (parsed.success) override.mode = parsed.data;
  }
  const rawBaseline = env[VENDOR_NAME_CHECK_BASELINE_ENV];
  if (rawBaseline !== undefined && String(rawBaseline).trim() !== "") {
    const value = Number(String(rawBaseline).trim());
    const parsed = baselineSchema.safeParse(value);
    if (parsed.success) override.baseline = parsed.data;
  }
  return override;
}

/**
 * Resolves the effective setting with the source of each key. An override that
 * parsed wins over the stored value; without one the stored value applies;
 * without either the built-in default.
 */
export function resolveVendorNameCheckSettings(
  options: { stored?: unknown; env?: Record<string, string | undefined> } = {},
): ResolvedVendorNameCheckSettings {
  const env = options.env ?? {};
  const stored = normalizeVendorNameCheckSettings(options.stored);
  const override = readVendorNameCheckEnvOverride(env);
  return {
    settings: {
      mode: override.mode ?? stored?.mode ?? DEFAULT_VENDOR_NAME_CHECK_MODE,
      baseline: override.baseline ?? stored?.baseline ?? DEFAULT_VENDOR_NAME_CHECK_BASELINE,
    },
    sources: {
      mode: override.mode !== undefined ? "env" : stored ? "settings" : "default",
      baseline: override.baseline !== undefined ? "env" : stored ? "settings" : "default",
    },
  };
}

/**
 * Merges a patch onto the STORED value, never onto the resolved one: writing
 * the resolved object back would bake an active environment override into the
 * database as if an operator had chosen it in the UI.
 */
export function mergeVendorNameCheckSettings(
  stored: VendorNameCheckSettings | null,
  patch: VendorNameCheckSettingsPatch,
): VendorNameCheckSettings {
  const base = stored ?? {
    mode: DEFAULT_VENDOR_NAME_CHECK_MODE,
    baseline: DEFAULT_VENDOR_NAME_CHECK_BASELINE,
  };
  return {
    mode: patch.mode ?? base.mode,
    baseline: patch.baseline ?? base.baseline,
  };
}