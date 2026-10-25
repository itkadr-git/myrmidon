// myrmidon(LICENSING): license format of the closed connector modules —
// VERIFICATION ONLY.
//
//   MYR1.<b64url(payload)>.<b64url(ed25519-signature)>
//
// The payload is canonical JSON (sorted keys, tight separators, ASCII only)
// with exactly the fields rev, instance_id, modules, features, expires,
// watermark (plus an optional kid). The signature covers the raw payload
// bytes; the verifier never re-serializes and mirrors the module-side check.
// The board cannot mint a license: issuing lives in the vendor's closed module
// and no private key is ever loaded here.
//
// Also here: the MYRQ1 license request blob the client copies from the
// licensing screen and sends to the vendor.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

export const CONTRACT_REV = 1;
export const KEY_PREFIX = "MYR1";
export const CORE_FEATURE = "core";
export const KNOWN_MODULES = ["google-ai", "antigravity", "chatgpt-pool"] as const;
export type KnownModule = (typeof KNOWN_MODULES)[number];

export const REQUEST_PREFIX = "MYRQ1";

export interface LicensePayload {
  rev: number;
  instance_id: string;
  modules: string[];
  features: string[];
  expires: number | null;
  watermark: string | null;
  /** optional signed license id (UUID); only licenses issued with one carry it */
  id?: string;
}

function b64urlEncode(raw: Buffer): string {
  return raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strictB64urlDecode(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("not base64url");
  return Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Python `json.dumps(ensure_ascii=True)` escapes every non-ASCII UTF-16 unit
 * as a lowercase \uXXXX; JSON.stringify leaves them raw, so escape here. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type VerifyReason =
  | "ok"
  | "no_license"
  | "unreadable"
  | "bad_format"
  | "bad_signature"
  | "bad_payload"
  | "unsupported_rev"
  | "instance_mismatch"
  | "expired"
  | "module_not_granted"
  | "feature_not_granted"
  | "revoked";

/**
 * A public key the board trusts for license signatures. `kid` names the key
 * in licenses that carry a `kid` field; `null` is a key known only by its
 * bytes (the original key, whose licenses carry no `kid`).
 */
/** A public key the board trusts for license signatures (PEM text or key object). */
export type TrustedIssuerKey = KeyObject | string;

const PAYLOAD_FIELDS = ["rev", "instance_id", "modules", "features", "expires", "watermark"] as const;
const OPTIONAL_PAYLOAD_FIELDS = ["kid", "id"] as const;
/** Module-side `KEY_ID_LEN`. */
export const KEY_ID_LEN = 16;

function asKeyObject(key: TrustedIssuerKey): KeyObject {
  return typeof key === "string" ? createPublicKey(key) : key;
}

/** Module-side `key_id`: first 16 hex of sha256 over the raw 32-byte Ed25519 public key. */
export function keyId(key: TrustedIssuerKey): string {
  const der = asKeyObject(key).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der.subarray(der.length - 32)).digest("hex").slice(0, KEY_ID_LEN);
}

/**
 * Mirror of the module-side verification, in the same order of checks
 * (presence, envelope, signature, payload shape and kid, rev, instance,
 * expiry, module, feature).
 *
 * Key rotation, as in the modules: `publicKey` may be a list of trusted keys
 * and a license verifies if ANY of them verifies its signature. The optional
 * `kid` payload field must then equal the id of the key that verified it;
 * licenses without `kid` (minted before rotation support) keep verifying for
 * as long as their key stays in the list.
 */
export function verifyLicense(
  licenseText: string | null | undefined,
  instanceId: string,
  nowSeconds: number,
  publicKey: TrustedIssuerKey | readonly TrustedIssuerKey[],
  opts: { requiredModule?: string; requiredFeature?: string | null } = {},
): {
  valid: boolean;
  reason: VerifyReason;
  payload?: LicensePayload;
  kid?: string | null;
  signerKid?: string;
  /** On `instance_mismatch`: the installation id the license was issued for. */
  licenseInstanceId?: string;
} {
  const fail = (reason: VerifyReason) => ({ valid: false, reason });
  if (!licenseText || !licenseText.trim()) return fail("no_license");
  const parts = licenseText.trim().split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) return fail("bad_format");
  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = strictB64urlDecode(parts[1]);
    signature = strictB64urlDecode(parts[2]);
  } catch {
    return fail("bad_format");
  }
  const trusted: readonly TrustedIssuerKey[] = Array.isArray(publicKey)
    ? (publicKey as readonly TrustedIssuerKey[])
    : [publicKey as TrustedIssuerKey];
  let signer: KeyObject | null = null;
  for (const candidate of trusted) {
    const key = asKeyObject(candidate);
    try {
      if (verify(null, payloadBytes, key, signature)) {
        signer = key;
        break;
      }
    } catch {
      return fail("bad_format");
    }
  }
  if (!signer) return fail("bad_signature");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return fail("bad_payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("bad_payload");
  const keys = Object.keys(payload);
  const allowed = new Set<string>([...PAYLOAD_FIELDS, ...OPTIONAL_PAYLOAD_FIELDS]);
  if (!PAYLOAD_FIELDS.every((f) => keys.includes(f)) || !keys.every((k) => allowed.has(k))) {
    return fail("bad_payload");
  }
  // Signed by a trusted key but labelled with another key's id: refused.
  if ("kid" in payload && payload.kid !== keyId(signer)) return fail("bad_payload");
  const { rev, instance_id: pInstance, modules, features, expires, watermark } = payload as Record<string, unknown>;
  const strList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if ("id" in payload && (typeof payload.id !== "string" || payload.id.length === 0)) return fail("bad_payload");
  if (!Number.isInteger(rev)) return fail("bad_payload");
  if (typeof pInstance !== "string" || !pInstance) return fail("bad_payload");
  if (!strList(modules) || !strList(features)) return fail("bad_payload");
  if (expires !== null && !Number.isInteger(expires)) return fail("bad_payload");
  if (watermark !== null && typeof watermark !== "string") return fail("bad_payload");
  if (rev !== CONTRACT_REV) return fail("unsupported_rev");
  if (pInstance !== instanceId) return { ...fail("instance_mismatch"), licenseInstanceId: pInstance };
  if (expires !== null && (expires as number) <= nowSeconds) return fail("expired");
  if (opts.requiredModule && !modules.includes(opts.requiredModule)) return fail("module_not_granted");
  const requiredFeature = opts.requiredFeature === undefined ? CORE_FEATURE : opts.requiredFeature;
  if (requiredFeature && !features.includes(requiredFeature)) return fail("feature_not_granted");
  const result: LicensePayload = {
    rev: rev as number,
    instance_id: pInstance,
    modules,
    features,
    expires: expires as number | null,
    watermark: watermark as string | null,
    ...(typeof payload.id === "string" ? { id: payload.id } : {}),
  };
  return { valid: true, reason: "ok", payload: result, kid: typeof payload.kid === "string" ? payload.kid : null, signerKid: keyId(signer) };
}

// --- MYRQ1 license request ---------------------------------------------------

export const UNKNOWN_BOARD = "unknown";
export const MAX_BOARD_CHARS = 32;

/** `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))`: whole seconds, UTC. */
function requestTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The MYRQ1 blob exactly as the module side builds it (`build_request`):
 * sorted keys, tight separators, ASCII-only JSON, whole-second UTC time,
 * board version capped at 32 chars (`unknown` when empty), modules sorted and
 * restricted to the known closed modules (at least one). The same inputs give
 * the same bytes on both sides, so the vendor's reference parser accepts it.
 */
export function buildLicenseRequest(input: {
  instanceId: string;
  board: string;
  modules: readonly string[];
  now?: Date;
}): string {
  const modules = sortedUnique(input.modules);
  if (modules.length === 0) throw new Error("at least one module is required");
  const unknown = modules.filter((m) => !(KNOWN_MODULES as readonly string[]).includes(m));
  if (unknown.length > 0) throw new Error(`unknown module(s): ${unknown.join(", ")}`);
  const board = (input.board || UNKNOWN_BOARD).slice(0, MAX_BOARD_CHARS);
  const text =
    "{" +
    [
      `"board":${asciiJson(board)}`,
      `"instance_id":${asciiJson(input.instanceId)}`,
      `"modules":${asciiJson(modules)}`,
      `"ts":${asciiJson(requestTimestamp(input.now ?? new Date()))}`,
      `"v":1`,
    ].join(",") +
    "}";
  return `${REQUEST_PREFIX}.${b64urlEncode(Buffer.from(text, "ascii"))}`;
}
