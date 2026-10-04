// packages/shared/src/myrmidon-plugin-entitlement.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C): the shared contract of plugin entitlement
// keys. A plugin whose manifest sets `requiresEntitlement: true` stays
// unactivated (and hidden from menus and settings) until the instance admin
// accepts a valid entitlement key for it in the instance settings UI.
//
// The keys live in `instance_settings.general.pluginEntitlementKeys` (the
// same row shape the other myrmidon general keys use). The value is a list
// because one key entitles exactly one plugin; expiry is per key.
//
// No real key verification exists yet (ML1/ML2 API is the dependency); this
// contract deliberately accepts any non-empty key string so the UI and the
// storage flow can ship and be tested independently of the verifier.

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its keys under. */
export const PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY = "pluginEntitlementKeys";

const isoDateSchema = z.string().datetime({ offset: true }).or(z.date());

/** One accepted entitlement key: which plugin it unlocks and until when. */
export const pluginEntitlementKeySchema = z
  .object({
    /** Manifest id of the plugin this key entitles (e.g. `com.example.premium`). */
    pluginId: z.string().min(1).max(200),
    /** The key itself. Opaque to the instance until the verifier (ML1/ML2) lands. */
    key: z.string().min(1).max(500),
    /** When this key stops entitling the plugin. Null = never expires. */
    expiresAt: isoDateSchema.nullable().default(null),
    /** When the key was accepted (set by the server, informational). */
    acceptedAt: isoDateSchema.nullable().default(null),
  })
  .strict();

/** All accepted keys as stored in the general settings row. */
export const pluginEntitlementKeysSchema = z
  .array(pluginEntitlementKeySchema)
  .max(100);

/** Body of `PATCH /api/myrmidon/plugin-entitlement/keys`. */
export const acceptPluginEntitlementKeySchema = z
  .object({
    pluginId: z.string().min(1).max(200),
    key: z.string().min(1).max(500),
    expiresAt: isoDateSchema.nullable().optional(),
  })
  .strict();

export type PluginEntitlementKey = z.infer<typeof pluginEntitlementKeySchema>;
export type AcceptPluginEntitlementKeyInput = z.infer<typeof acceptPluginEntitlementKeySchema>;

/** The stored list, or `[]` when the key is absent or malformed. */
export function normalizePluginEntitlementKeys(raw: unknown): PluginEntitlementKey[] {
  const parsed = pluginEntitlementKeysSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // A hand-edited row cannot half-apply: unreadable data means "no keys
  // registered", so no plugin is ever silently unlocked by corrupt rows.
  return [];
}

/** Whether the key currently entitles the plugin (not expired). */
export function isPluginEntitlementKeyActive(
  entry: PluginEntitlementKey,
  now: Date = new Date(),
): boolean {
  if (entry.expiresAt === null) return true;
  const expiresAt = entry.expiresAt instanceof Date ? entry.expiresAt : new Date(entry.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

/** The active key for a plugin, or null when none is accepted/unexpired. */
export function findActivePluginEntitlementKey(
  keys: PluginEntitlementKey[],
  pluginId: string,
  now: Date = new Date(),
): PluginEntitlementKey | null {
  return keys.find((entry) => entry.pluginId === pluginId && isPluginEntitlementKeyActive(entry, now)) ?? null;
}
