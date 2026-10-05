// server/src/myrmidon/plugin-entitlement/store.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): read and write
// `instance_settings.general.pluginEntitlementKeys`.
//
// The stored list is the single truth (no env fallback — which plugins are
// unlocked is a licensing choice, not a deployment knob). An absent or
// malformed row means "no keys registered": every entitlement-requiring
// plugin stays unactivated. Same storage shape the wip-limit settings use.

import {
  PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY,
  normalizePluginEntitlementKeys,
  pluginEntitlementKeySchema,
  type PluginEntitlementKey,
} from "@paperclipai/shared";
import type { instanceSettingsService } from "../../services/instance-settings.js";

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
