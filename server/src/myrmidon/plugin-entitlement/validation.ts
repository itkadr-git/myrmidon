// server/src/myrmidon/plugin-entitlement/validation.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): pure key checks shared by the route and the
// loader gate. Deliberately dependency-free so both the API path and the
// plugin activation path can call it without pulling each other's modules.

import { z } from "zod";
import {
  findActivePluginEntitlementKey,
  type PluginEntitlementKey,
} from "@paperclipai/shared";

/** Input of POST /api/myrmidon/plugin-entitlement/keys/accept. */
export const acceptKeyRequestSchema = z
  .object({
    /** Manifest id of the plugin the key should unlock. */
    pluginId: z.string().min(1).max(200),
    /** The key string itself. */
    key: z.string().min(1).max(500),
  })
  .strict();

export type AcceptKeyRequest = z.infer<typeof acceptKeyRequestSchema>;

export type KeyValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Local pre-checks of an incoming key before it is stored: shape and emptiness.
 * The cryptographic verdict arrives with ML1/ML2; until then a syntactically
 * valid key for a known plugin id is accepted, which the manifest gate turns
 * into "plugin enabled". Returning a structured error (not a throw) keeps the
 * route able to answer 400 with a clear message.
 */
export function validateIncomingKey(input: {
  pluginId: string;
  key: string;
}): KeyValidationResult {
  const trimmedId = input.pluginId.trim();
  if (!trimmedId) {
    return { ok: false, error: "pluginId is required" };
  }
  const trimmedKey = input.key.trim();
  if (!trimmedKey) {
    return { ok: false, error: "key is required" };
  }
  if (trimmedKey.length > 500) {
    return { ok: false, error: "key is too long" };
  }
  return { ok: true };
}

/**
 * Whether `pluginId` is currently entitled by an accepted, unexpired key.
 * This is the loader gate: a plugin with `requiresEntitlement` whose id has
 * no active key is not activated and stays hidden.
 */
export function isPluginEntitled(
  keys: PluginEntitlementKey[],
  pluginId: string,
  now: Date = new Date(),
): boolean {
  return findActivePluginEntitlementKey(keys, pluginId, now) !== null;
}
