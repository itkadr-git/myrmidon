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
// myrmidon(1.6.3 PLUGIN-ENTITLEMENT A): the key is an ed25519-signed token.
// The environment-independent parts of the format — the token wire shape,
// the payload schema, and the parser — live here so the server verifier, the
// route, and any test can agree on them without importing node:crypto.
// The signature check itself is server-side
// (server/src/myrmidon/plugin-entitlement/validation.ts).

import { z } from "zod";

/** The `instance_settings.general` key this feature stores its keys under. */
export const PLUGIN_ENTITLEMENT_KEYS_SETTINGS_KEY = "pluginEntitlementKeys";

/** The `instance_settings.general` key holding the ed25519 verification public key (PEM). */
export const PLUGIN_ENTITLEMENT_PUBLIC_KEY_SETTINGS_KEY = "pluginEntitlementPublicKey";

const isoDateSchema = z.string().datetime({ offset: true }).or(z.date());

/**
 * The signed payload of an entitlement token: which plugin it unlocks, for
 * which instance, and until when. `instanceId` is the board's instance id
 * (`PAPERCLIP_INSTANCE_ID`, default "default"); a token issued for another
 * instance is rejected. `expiresAt` is required and must be finite —
 * "never expires" is not expressible in a token (it is an accepted-key row
 * property only).
 */
export const pluginEntitlementTokenPayloadSchema = z
  .object({
    pluginId: z.string().min(1).max(200),
    instanceId: z.string().min(1).max(200),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PluginEntitlementTokenPayload = z.infer<typeof pluginEntitlementTokenPayloadSchema>;

/**
 * The token wire format: `PEK1.<base64url payload JSON>.<base64url signature>`.
 * The prefix makes the value recognizable and greppable in logs (the
 * redaction layer masks it); the parts are dot-separated and unpadded.
 */
export const PLUGIN_ENTITLEMENT_TOKEN_PREFIX = "PEK1.";

/** A parsed, shape-valid token. Signature verification is server-side. */
export interface ParsedPluginEntitlementToken {
  /** The raw token string exactly as accepted. */
  raw: string;
  /** The decoded payload (pluginId, instanceId, expiresAt). */
  payload: PluginEntitlementTokenPayload;
  /** The base64url signature segment (unverified). */
  signatureB64: string;
  /** The exact payload segment string that the signature covers. */
  signedPayload: string;
}

/**
 * Parse and shape-check a token string without verifying the signature.
 * Returns null when the string is not a PEK1 token of a valid shape.
 * Pure: no environment access, no crypto.
 */
export function parsePluginEntitlementToken(raw: string): ParsedPluginEntitlementToken | null {
  const value = raw.trim();
  if (!value.startsWith(PLUGIN_ENTITLEMENT_TOKEN_PREFIX)) return null;
  const rest = value.slice(PLUGIN_ENTITLEMENT_TOKEN_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return null;
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let payloadRaw: unknown;
  try {
    payloadRaw = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const parsed = pluginEntitlementTokenPayloadSchema.safeParse(payloadRaw);
  if (!parsed.success) return null;
  return {
    raw: value,
    payload: parsed.data,
    signatureB64,
    signedPayload: payloadB64,
  };
}

/** One accepted entitlement key: which plugin it unlocks and until when. */
export const pluginEntitlementKeySchema = z
  .object({
    /** Manifest id of the plugin this key entitles (e.g. `com.example.premium`). */
    pluginId: z.string().min(1).max(200),
    /**
     * The key: a `PEK1.` ed25519-signed token. Stored in full — later passes
     * re-verify the signature against the instance's verification public key,
     * so the whole token must remain available. Never returned by the API
     * (the route strips it) and masked in logs by the redaction layer.
     */
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

/**
 * The shape of one entry in the API response (GET list, POST accept result).
 * The key value is deliberately absent: the list API never returns key
 * values (acceptance criterion of the feature).
 */
export const pluginEntitlementKeyViewSchema = z
  .object({
    pluginId: z.string().min(1).max(200),
    expiresAt: isoDateSchema.nullable(),
    acceptedAt: isoDateSchema.nullable(),
  })
  .strict();

export type PluginEntitlementKeyView = z.infer<typeof pluginEntitlementKeyViewSchema>;

/**
 * Strip the key values from a stored list. Used on every API response and
 * everywhere a stored list must not leak key values (the route, tests).
 */
export function toPluginEntitlementKeyViews(
  keys: PluginEntitlementKey[],
): PluginEntitlementKeyView[] {
  return keys.map((entry) => ({
    pluginId: entry.pluginId,
    expiresAt: entry.expiresAt ?? null,
    acceptedAt: entry.acceptedAt ?? null,
  }));
}

/**
 * The shape of the verification-settings response of
 * `GET/PUT /api/myrmidon/plugin-entitlement/public-key`: the effective
 * ed25519 public key (PEM) and where the value came from. "none" means no
 * public key is configured, so no entitlement token can verify (fail closed).
 */
export const pluginEntitlementPublicKeyViewSchema = z
  .object({
    publicKey: z.string().nullable(),
    source: z.enum(["settings", "env", "none"]),
  })
  .strict();

export type PluginEntitlementPublicKeyView = z.infer<typeof pluginEntitlementPublicKeyViewSchema>;

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
