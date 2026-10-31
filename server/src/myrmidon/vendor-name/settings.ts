// server/src/myrmidon/vendor-name/settings.ts
//
// myrmidon(1.7-REBRAND-F): where the vendor-name gate setting lives and how it
// survives every vendor write of `instance_settings.general`.
//
// The mode and the baseline are read at request time (not cached at boot), so a
// settings-page change reaches the next read without a server restart. The
// environment variables stay a forced override for an instance that never saved
// the setting — the same precedence shape RUNTIME-LIMITS and BUDGET-CONFIG-B
// use.

import {
  VENDOR_NAME_CHECK_BASELINE_ENV,
  VENDOR_NAME_CHECK_MODE_ENV,
  VENDOR_NAME_CHECK_SETTINGS_KEY,
  normalizeVendorNameCheckSettings,
  resolveVendorNameCheckSettings,
  type ResolvedVendorNameCheckSettings,
  type VendorNameCheckSettings,
} from "@paperclipai/shared";

export {
  VENDOR_NAME_CHECK_BASELINE_ENV,
  VENDOR_NAME_CHECK_MODE_ENV,
  VENDOR_NAME_CHECK_SETTINGS_KEY,
};

/** The deps the reader needs, so tests can run it without a database. */
export interface VendorNameCheckSettingsDeps {
  getGeneral(): Promise<{ vendorNameCheck?: unknown }>;
  env?: Record<string, string | undefined>;
}

/**
 * The setting in force right now and where each value came from. A settings
 * read failure fails SAFE: the built-in default (`ratchet` against the count
 * the instance records) is what the rebrand ships with, so a transient read
 * error cannot silently turn the gate strict — or silent.
 */
export async function readVendorNameCheck(
  deps: VendorNameCheckSettingsDeps,
): Promise<ResolvedVendorNameCheckSettings> {
  let stored: unknown;
  try {
    const general = await deps.getGeneral();
    stored = general?.vendorNameCheck;
  } catch {
    stored = undefined;
  }
  return resolveVendorNameCheckSettings({
    stored,
    env: deps.env ?? process.env,
  });
}

/** The stored settings value, normalized; null when the row has nothing usable. */
export function normalizeStoredVendorNameCheck(raw: unknown): VendorNameCheckSettings | null {
  return normalizeVendorNameCheckSettings(raw);
}

/** Keep the stored setting across every vendor general write (same shape as WIP-LIMIT). */
export function preserveVendorNameCheckGeneralKey(storedGeneral: unknown): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[VENDOR_NAME_CHECK_SETTINGS_KEY];
  return value === undefined ? {} : { [VENDOR_NAME_CHECK_SETTINGS_KEY]: value };
}