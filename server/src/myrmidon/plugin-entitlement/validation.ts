// server/src/myrmidon/plugin-entitlement/validation.ts
//
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): pure key checks shared by the
// route and the loader gate, plus the ed25519 token verifier. The verifier
// is the only node:crypto dependency; everything else stays dependency-free
// so the API path and the activation path can call it without pulling each
// other's modules.
//
// Token format (PEK1): "PEK1.<base64url payload JSON>.<base64url signature>"
// with payload { pluginId, instanceId, expiresAt }. The signature is
// ed25519 over the exact payload segment (the base64url string between the
// prefix and the last dot). The verification public key (PEM) is an
// instance setting — `general.pluginEntitlementPublicKey` — changeable in
// the UI without a restart.

import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  parsePluginEntitlementToken,
  type PluginEntitlementKey,
} from "@paperclipai/shared";
import { findActivePluginEntitlementKey } from "@paperclipai/shared";

/** Input of POST /api/myrmidon/plugin-entitlement/keys. */
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

/** The verdict of a full (shape + signature + scope) token check. */
export type EntitlementTokenVerdict =
  | { valid: true; pluginId: string; expiresAt: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "no_public_key" | "expired" | "wrong_instance" | "wrong_plugin" };

/** The rejected branch of a verdict — the only one that has a message. */
export type InvalidEntitlementTokenVerdict = Extract<EntitlementTokenVerdict, { valid: false }>;

export interface VerifyTokenContext {
  /** The ed25519 verification public key in PEM (from instance settings). */
  publicKeyPem: string;
  /** This board instance's id (`PAPERCLIP_INSTANCE_ID`, default "default"). */
  instanceId: string;
  /** The plugin id the caller wants to entitle. */
  pluginId: string;
  /** Clock for the expiry check. */
  now?: Date;
}

/**
 * Full verification of an entitlement token: parse, check the ed25519
 * signature against the instance verification key, then check the scope —
 * the token's pluginId must match the requested one, its instanceId must
 * equal this instance, and it must not be expired.
 */
export function verifyEntitlementToken(
  key: string,
  context: VerifyTokenContext,
): EntitlementTokenVerdict {
  const token = parsePluginEntitlementToken(key);
  if (!token) return { valid: false, reason: "malformed" };
  const now = context.now ?? new Date();
  const pem = context.publicKeyPem?.trim();
  if (!pem) return { valid: false, reason: "no_public_key" };
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(pem);
  } catch {
    // An unparseable stored key is a configuration error, not a forgery;
    // fail closed either way — the token cannot be verified.
    return { valid: false, reason: "bad_signature" };
  }
  const signature = Buffer.from(token.signatureB64, "base64url");
  if (signature.length === 0) return { valid: false, reason: "bad_signature" };
  let signatureOk = false;
  try {
    signatureOk = verify(
      null,
      Buffer.from(token.signedPayload, "utf8"),
      publicKey,
      signature,
    );
  } catch {
    return { valid: false, reason: "bad_signature" };
  }
  if (!signatureOk) return { valid: false, reason: "bad_signature" };
  if (token.payload.pluginId !== context.pluginId) return { valid: false, reason: "wrong_plugin" };
  if (token.payload.instanceId !== context.instanceId) return { valid: false, reason: "wrong_instance" };
  const expiresAt = new Date(token.payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, pluginId: token.payload.pluginId, expiresAt: token.payload.expiresAt };
}

/** The 400 error message for an invalid token (no key material inside). */
export function entitlementTokenErrorMessage(verdict: InvalidEntitlementTokenVerdict): string {
  switch (verdict.reason) {
    case "malformed":
      return "the key is not a valid PEK1 entitlement token";
    case "no_public_key":
      return "no verification public key is configured on this instance";
    case "bad_signature":
      return "the key signature does not verify against this instance's public key";
    case "expired":
      return "the key is expired";
    case "wrong_instance":
      return "the key was issued for a different instance";
    case "wrong_plugin":
      return "the key does not entitle this plugin";
  }
}

/** Body of `PUT /api/myrmidon/plugin-entitlement/public-key`. */
export const setPublicKeyRequestSchema = z
  .object({
    /** PEM ed25519 public key; null or an empty string clears the setting. */
    publicKey: z.string().max(2000).nullable(),
  })
  .strict();

export type SetPublicKeyRequest = z.infer<typeof setPublicKeyRequestSchema>;

/**
 * Whether the string is a usable ed25519 *public* key: a PEM/SPKI public key
 * whose key type is ed25519. Checked before the value is stored, so a typo
 * cannot silently replace a working key with an unusable one — and a pasted
 * private key is refused (node:crypto would happily derive its public key,
 * which would let a secret slip into a non-secret setting).
 */
export function isValidEd25519PublicKey(value: string): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (/PRIVATE KEY/.test(trimmed)) return false;
  try {
    const key = createPublicKey(trimmed);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Local pre-checks of an incoming key before it is stored: shape and
 * emptiness. Signature verification happens in the route (it needs the
 * instance public key and instance id); returning a structured error (not a
 * throw) keeps the route able to answer 400 with a clear message.
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
 * no active key is not activated and stays hidden. Signature re-verification
 * on the activation path is done by `verifyStoredKeys` (see below) —
 * expiry alone must not be the verdict.
 */
export function isPluginEntitled(
  keys: PluginEntitlementKey[],
  pluginId: string,
  now: Date = new Date(),
): boolean {
  return findActivePluginEntitlementKey(keys, pluginId, now) !== null;
}
