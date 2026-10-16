// myrmidon(LICENSING): license format of the closed connector modules.
//
//   MYR1.<b64url(payload)>.<b64url(ed25519-signature)>
//
// The payload is canonical JSON (sorted keys, tight separators, ASCII only)
// with exactly the fields rev, instance_id, modules, features, expires,
// watermark. The signature covers the raw payload bytes; a verifier never
// re-serializes. This file is the issuing side plus a verifier that mirrors
// the module-side check (used by the tests and by nothing at runtime).
//
// Also here: the MYRQ1 license request blob the client copies from the
// licensing screen and the owner pastes into the issue form.

import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const CONTRACT_REV = 1;
export const KEY_PREFIX = "MYR1";
export const CORE_FEATURE = "core";
export const KNOWN_MODULES = ["google-ai", "antigravity", "chatgpt-pool"] as const;
export type KnownModule = (typeof KNOWN_MODULES)[number];

export const REQUEST_PREFIX = "MYRQ1";
const REQUEST_RE = /^MYRQ1\.[A-Za-z0-9_-]+$/;
const INSTANCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const FEATURE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_WATERMARK_CHARS = 80;
export const MAX_LICENSE_DAYS = 3650;

export interface LicensePayload {
  rev: number;
  instance_id: string;
  modules: string[];
  features: string[];
  expires: number | null;
  watermark: string | null;
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

/** The exact bytes the module side produces: keys in sorted order. */
export function canonicalPayload(input: {
  instanceId: string;
  modules: readonly string[];
  features: readonly string[];
  expires: number | null;
  watermark: string | null;
  rev?: number;
}): Buffer {
  const text =
    "{" +
    [
      `"expires":${asciiJson(input.expires)}`,
      `"features":${asciiJson(sortedUnique(input.features))}`,
      `"instance_id":${asciiJson(input.instanceId)}`,
      `"modules":${asciiJson(sortedUnique(input.modules))}`,
      `"rev":${asciiJson(input.rev ?? CONTRACT_REV)}`,
      `"watermark":${asciiJson(input.watermark)}`,
    ].join(",") +
    "}";
  return Buffer.from(text, "ascii");
}

export function issueLicense(
  privateKey: KeyObject,
  input: {
    instanceId: string;
    modules: readonly string[];
    features: readonly string[];
    expires: number | null;
    watermark: string | null;
  },
): { license: string; payload: LicensePayload } {
  const payloadBytes = canonicalPayload(input);
  const signature = sign(null, payloadBytes, privateKey);
  return {
    license: `${KEY_PREFIX}.${b64urlEncode(payloadBytes)}.${b64urlEncode(signature)}`,
    payload: JSON.parse(payloadBytes.toString("ascii")) as LicensePayload,
  };
}

export type VerifyReason =
  | "ok"
  | "no_license"
  | "bad_format"
  | "bad_signature"
  | "bad_payload"
  | "unsupported_rev"
  | "instance_mismatch"
  | "expired"
  | "module_not_granted"
  | "feature_not_granted";

/** Mirror of the module-side verification, in the same order of checks. */
export function verifyLicense(
  licenseText: string | null | undefined,
  instanceId: string,
  nowSeconds: number,
  publicKey: KeyObject | string,
  opts: { requiredModule?: string; requiredFeature?: string | null } = {},
): { valid: boolean; reason: VerifyReason; payload?: LicensePayload } {
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
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  if (!verify(null, payloadBytes, key, signature)) return fail("bad_signature");
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return fail("bad_payload");
  }
  const fields = ["rev", "instance_id", "modules", "features", "expires", "watermark"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fail("bad_payload");
  const keys = Object.keys(payload);
  if (keys.length !== fields.length || !fields.every((f) => keys.includes(f))) return fail("bad_payload");
  const { rev, instance_id: pInstance, modules, features, expires, watermark } = payload as Record<string, unknown>;
  const strList = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if (!Number.isInteger(rev)) return fail("bad_payload");
  if (typeof pInstance !== "string" || !pInstance) return fail("bad_payload");
  if (!strList(modules) || !strList(features)) return fail("bad_payload");
  if (expires !== null && !Number.isInteger(expires)) return fail("bad_payload");
  if (watermark !== null && typeof watermark !== "string") return fail("bad_payload");
  if (rev !== CONTRACT_REV) return fail("unsupported_rev");
  if (pInstance !== instanceId) return fail("instance_mismatch");
  if (expires !== null && (expires as number) <= nowSeconds) return fail("expired");
  if (opts.requiredModule && !modules.includes(opts.requiredModule)) return fail("module_not_granted");
  const requiredFeature = opts.requiredFeature === undefined ? CORE_FEATURE : opts.requiredFeature;
  if (requiredFeature && !features.includes(requiredFeature)) return fail("feature_not_granted");
  return { valid: true, reason: "ok", payload: payload as unknown as LicensePayload };
}

// --- MYRQ1 license request ---------------------------------------------------

export interface LicenseRequest {
  v: 1;
  instance_id: string;
  board: string;
  modules: string[];
  ts: string;
  py?: string;
}

export function isValidInstanceId(value: unknown): value is string {
  return typeof value === "string" && INSTANCE_ID_RE.test(value);
}

export function buildLicenseRequest(input: {
  instanceId: string;
  board: string;
  modules: readonly string[];
  now?: Date;
}): string {
  const body: LicenseRequest = {
    v: 1,
    instance_id: input.instanceId,
    board: input.board,
    modules: sortedUnique(input.modules),
    ts: (input.now ?? new Date()).toISOString(),
  };
  return `${REQUEST_PREFIX}.${b64urlEncode(Buffer.from(JSON.stringify(body), "utf8"))}`;
}

/** Returns null for anything that is not a well-formed request: the caller
 * shows one generic message, never the parse details. */
export function parseLicenseRequest(text: unknown): LicenseRequest | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length > 4096 || !REQUEST_RE.test(trimmed)) return null;
  try {
    const raw = JSON.parse(strictB64urlDecode(trimmed.slice(REQUEST_PREFIX.length + 1)).toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.v !== 1 || !isValidInstanceId(raw.instance_id)) return null;
    if (!Array.isArray(raw.modules) || !raw.modules.every((m: unknown) => typeof m === "string")) return null;
    return {
      v: 1,
      instance_id: raw.instance_id,
      board: typeof raw.board === "string" ? raw.board.slice(0, 40) : "",
      modules: raw.modules.slice(0, 20).map((m: string) => m.slice(0, 64)),
      ts: typeof raw.ts === "string" ? raw.ts.slice(0, 40) : "",
      ...(typeof raw.py === "string" ? { py: raw.py.slice(0, 16) } : {}),
    };
  } catch {
    return null;
  }
}
