// server/src/services/plugin-entitlement-enforcement.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): loader-side activation gate.
// PluginLoader consults this before a plugin with `requiresEntitlement:
// true` is allowed to activate (spawn a worker, register UI slots, appear
// in menus).
//
// The check re-reads the settings row on every activation pass, so accepting
// a key in the UI enables the plugin on the next pass without a restart.
// The cryptographic verdict is part of the gate: a stored key must carry a
// valid ed25519 signature for this instance (re-verified here, because the
// verification public key can rotate after a key was accepted). A stored
// key with a bad/expired/mismatched signature does not entitle the plugin.

import type { PaperclipPluginManifestV1, PluginEntitlementKey } from "@paperclipai/shared";
import { findActivePluginEntitlementKey } from "@paperclipai/shared";
import { verifyEntitlementToken } from "../myrmidon/plugin-entitlement/validation.js";

/** Whether the manifest opts into entitlement gating. */
export function manifestRequiresEntitlement(
  manifest: Pick<PaperclipPluginManifestV1, "id"> & Partial<Pick<PaperclipPluginManifestV1, "requiresEntitlement">>,
): boolean {
  return manifest.requiresEntitlement === true;
}

/**
 * The activation decision for one manifest against the currently accepted
 * keys. A plugin that does not require entitlement is always allowed; an
 * entitlement-requiring plugin needs an active, cryptographically valid key
 * for its exact id.
 *
 * `verificationContext` supplies the instance public key and instance id
 * (read fresh by the caller from the settings row — rotation applies without
 * a restart). When it is omitted the check degrades to "not entitled":
 * no public key configured means no key can verify.
 */
export function resolvePluginActivation(
  manifest: Pick<PaperclipPluginManifestV1, "id"> & Partial<Pick<PaperclipPluginManifestV1, "requiresEntitlement">>,
  keys: PluginEntitlementKey[],
  verificationContext?: {
    publicKeyPem: string | null;
    instanceId: string;
    now?: Date;
  },
): { activate: boolean; reason: "no_entitlement_required" | "entitled" | "no_active_key" | "invalid_key" } {
  if (manifest.requiresEntitlement !== true) {
    return { activate: true, reason: "no_entitlement_required" };
  }
  const now = verificationContext?.now ?? new Date();
  const active = findActivePluginEntitlementKey(keys, manifest.id, now);
  if (!active) {
    return { activate: false, reason: "no_active_key" };
  }
  if (!verificationContext?.publicKeyPem) {
    // No verification key configured: no stored key can be trusted.
    return { activate: false, reason: "invalid_key" };
  }
  const verdict = verifyEntitlementToken(active.key, {
    publicKeyPem: verificationContext.publicKeyPem,
    instanceId: verificationContext.instanceId,
    pluginId: manifest.id,
    now,
  });
  if (!verdict.valid) {
    return { activate: false, reason: "invalid_key" };
  }
  return { activate: true, reason: "entitled" };
}
