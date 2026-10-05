// server/src/services/plugin-entitlement-enforcement.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): loader-side activation gate. PluginLoader
// consults this before a plugin with `requiresEntitlement: true` is allowed
// to activate (spawn a worker, register UI slots, appear in menus).
//
// The check re-reads the settings row on every activation pass, so accepting
// a key in the UI enables the plugin on the next pass without a restart.

import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { findActivePluginEntitlementKey, type PluginEntitlementKey } from "@paperclipai/shared";

/** Whether the manifest opts into entitlement gating. */
export function manifestRequiresEntitlement(
  manifest: Pick<PaperclipPluginManifestV1, "id"> & Partial<Pick<PaperclipPluginManifestV1, "requiresEntitlement">>,
): boolean {
  return manifest.requiresEntitlement === true;
}

/**
 * The activation decision for one manifest against the currently accepted
 * keys. A plugin that does not require entitlement is always allowed;
 * an entitlement-requiring plugin needs an active key for its exact id.
 */
export function resolvePluginActivation(
  manifest: Pick<PaperclipPluginManifestV1, "id"> & Partial<Pick<PaperclipPluginManifestV1, "requiresEntitlement">>,
  keys: PluginEntitlementKey[],
  now: Date = new Date(),
): { activate: boolean; reason: "no_entitlement_required" | "entitled" | "no_active_key" } {
  if (manifest.requiresEntitlement !== true) {
    return { activate: true, reason: "no_entitlement_required" };
  }
  const active = findActivePluginEntitlementKey(keys, manifest.id, now);
  return active
    ? { activate: true, reason: "entitled" }
    : { activate: false, reason: "no_active_key" };
}
