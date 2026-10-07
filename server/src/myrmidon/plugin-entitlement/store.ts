// server/src/myrmidon/plugin-entitlement/store.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): read and write
// `instance_settings.general.pluginEntitlementKeys`, and read the
// verification public key from `general.pluginEntitlementPublicKey`.
//
// The stored list is the single truth (no env fallback — which plugins are
// unlocked is a licensing choice, not a deployment knob). An absent or
// malformed row means "no keys registered": every entitlement-requiring
// plugin stays unactivated. Same storage shape the wip-limit settings use.
//
// The public key is also an instance setting (changeable in the UI without
// a restart). `MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` is the forced env
// override, read once per read call — the settings row wins when present.

import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY,
  normalizePluginEntitlementKeys,
  pluginEntitlementKeySchema,
  type PluginEntitlementKey,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

/** The forced env override for the verification public key. */
export const PLUGIN_ENTITLEMENT_PUBLIC_KEY_ENV = "MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY";

export type PluginEntitlementSettingsService = Pick<
  ReturnType<typeof instanceSettingsService>,
  "getGeneral" | "updateGeneral"
>;

/** Read the accepted keys (or `[]` when absent/malformed). */
export async function readPluginEntitlementKeys(
  settings: PluginEntitlementSettingsService,
): Promise<PluginEntitlementKey[]> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  return normalizePluginEntitlementKeys(general[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]);
}

/**
 * The ed25519 verification public key (PEM) for entitlement tokens. The
 * stored setting wins; `MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY` (PEM or a
 * base64 raw key) applies only when no setting is stored — the settings row
 * is the primary path so the key can be rotated in the UI without a restart.
 */
export async function readPluginEntitlementPublicKey(
  settings: PluginEntitlementSettingsService,
  runtimeEnv: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  return (await readPluginEntitlementPublicKeyWithSource(settings, runtimeEnv)).publicKey;
}

/** Where the effective verification public key comes from. */
export type PluginEntitlementPublicKeySource = "settings" | "env" | "none";

/**
 * The effective verification public key and where it came from: the stored
 * instance setting ("settings"), the forced env override ("env"), or nothing
 * configured at all ("none" — no token can verify; fail closed).
 */
export async function readPluginEntitlementPublicKeyWithSource(
  settings: PluginEntitlementSettingsService,
  runtimeEnv: Record<string, string | undefined> = process.env,
): Promise<{ publicKey: string | null; source: PluginEntitlementPublicKeySource }> {
  const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
  const stored = general[PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY];
  if (typeof stored === "string" && stored.trim().length > 0) {
    // Normalized on read: a value pasted with surrounding whitespace (the
    // general settings route does not trim) still verifies.
    return { publicKey: stored.trim(), source: "settings" };
  }
  const fromEnv = runtimeEnv[PLUGIN_ENTITLEMENT_PUBLIC_KEY_ENV]?.trim();
  if (!fromEnv) return { publicKey: null, source: "none" };
  // Accept a PEM string or a base64 raw 32-byte ed25519 public key.
  if (fromEnv.includes("-----BEGIN")) return { publicKey: fromEnv, source: "env" };
  const raw = Buffer.from(fromEnv, "base64");
  if (raw.length === 32) {
    // Wrap the bare 32-byte key in its SPKI envelope and PEM-armor it, so the
    // rest of the code only ever sees PEM.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const base64 = spki.toString("base64");
    return {
      publicKey: `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`,
      source: "env",
    };
  }
  return { publicKey: fromEnv, source: "env" };
}

/**
 * Store the verification public key in the instance settings (or clear it
 * when the value is null/empty). Takes effect without a restart: the route
 * and the loader gate read the settings row on each call/pass.
 */
export async function writePluginEntitlementPublicKey(
  settings: PluginEntitlementSettingsService,
  publicKey: string | null,
): Promise<void> {
  const value = publicKey?.trim() ? publicKey.trim() : undefined;
  await settings.updateGeneral({
    [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: value,
  } as never);
}

/** Validate and append one key (PUT semantics on the whole list). */
export async function acceptPluginEntitlementKey(
  settings: PluginEntitlementSettingsService,
  input: { pluginId: string; key: string; expiresAt?: string | null },
): Promise<PluginEntitlementKey[]> {
  const existing = await readPluginEntitlementKeys(settings);
  const parsed = pluginEntitlementKeySchema.parse({
    pluginId: input.pluginId,
    key: input.key,
    expiresAt: input.expiresAt ?? null,
    acceptedAt: new Date().toISOString(),
  });
  // One entry per plugin: a re-accepted key replaces the previous one so the
  // admin cannot stack stale keys for the same plugin.
  const next = [...existing.filter((entry) => entry.pluginId !== parsed.pluginId), parsed];
  await settings.updateGeneral({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: next } as never);
  return next;
}

/** Remove the key of one plugin; removing an absent pluginId is a no-op. */
export async function removePluginEntitlementKey(
  settings: PluginEntitlementSettingsService,
  pluginId: string,
): Promise<PluginEntitlementKey[]> {
  const existing = await readPluginEntitlementKeys(settings);
  const next = existing.filter((entry) => entry.pluginId !== pluginId);
  await settings.updateGeneral({ [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: next } as never);
  return next;
}

/**
 * Preserve the stored keys across vendor writes of `general` (same contract as
 * the other myrmidon preserve-*GeneralKey helpers).
 */
export function preservePluginEntitlementKeysGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY];
  return value === undefined ? {} : { [PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY]: value };
}

/**
 * Preserve the verification public key across vendor writes of `general`.
 */
export function preservePluginEntitlementPublicKeyGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY];
  return value === undefined ? {} : { [PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY]: value };
}
