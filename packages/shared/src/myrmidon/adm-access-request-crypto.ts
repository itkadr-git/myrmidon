// packages/shared/src/myrmidon/adm-access-request-crypto.ts
//
// 1.7 COMPANY-BOUNDARIES (OPE-12766): the node:crypto half of the ADM access
// request contract — scope hashing and the HMAC-signed capability token.
//
// SERVER-ONLY and deliberately NOT exported through the shared barrels: a
// top-level `node:crypto` import reachable from the barrel externalizes in
// Vite browser builds and crashes any browser harness that pulls in
// `@myrmidon/shared` at module-init time (OPE-12997 follow-up to #2955).
// Import via the package subpath, the same pattern as
// `@myrmidon/shared/portability-hash`:
//
//   import { admScopeHash, createAdmCapabilityToken, verifyAdmCapabilityToken } from "@myrmidon/shared/adm-access-request-crypto";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, type AdmCapabilityClaims } from "./adm-access-request.js";

/** Hash of the requested scope: audit carries the hash, never raw values. */
export function admScopeHash(scope: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

const CAPABILITY_TTL_FLOOR_SECONDS = 60;
const CAPABILITY_TTL_CEILING_SECONDS = 30 * 24 * 60 * 60;

function capabilitySecret(): string | null {
  const master = process.env.AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || "";
  return master.length > 0 ? master : null;
}

function capabilityKey(claims: { sourceCompanyId: string; targetCompanyId: string; requestId: string }) {
  const master = capabilitySecret();
  if (!master) return null;
  return createHmac(
    "sha256",
    master,
  )
    .update(`adm-access:${claims.sourceCompanyId}:${claims.targetCompanyId}:${claims.requestId}`)
    .digest();
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Issues the audience-bound short-lived capability token for an approved
 * request. Returns null when no signing secret is configured — the gateway
 * then refuses to approve instead of issuing an unverifiable capability.
 */
export function createAdmCapabilityToken(input: {
  requestId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  requesterType: string;
  requesterId: string;
  resourceType: string;
  resourceRef: string;
  action: string;
  scopeHash: string;
  ttlSeconds: number;
}): { token: string; expiresAt: Date; capabilityHash: string } | null {
  const key = capabilityKey(input);
  if (!key) return null;
  const ttl = Math.min(
    Math.max(Math.floor(input.ttlSeconds), CAPABILITY_TTL_FLOOR_SECONDS),
    CAPABILITY_TTL_CEILING_SECONDS,
  );
  const now = Math.floor(Date.now() / 1000);
  const claims: AdmCapabilityClaims = {
    requestId: input.requestId,
    sourceCompanyId: input.sourceCompanyId,
    targetCompanyId: input.targetCompanyId,
    requesterType: input.requesterType,
    requesterId: input.requesterId,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    action: input.action,
    scopeHash: input.scopeHash,
    iat: now,
    exp: now + ttl,
  };
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = createHmac("sha256", key).update(signingInput).digest("base64url");
  const token = `${signingInput}.${signature}`;
  const capabilityHash = createHash("sha256").update(token).digest("hex");
  return { token, expiresAt: new Date(claims.exp * 1000), capabilityHash };
}

export function verifyAdmCapabilityToken(
  token: string,
  expected?: {
    requestId: string;
    sourceCompanyId: string;
    targetCompanyId: string;
  },
): AdmCapabilityClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const requestId = typeof claims.requestId === "string" ? claims.requestId : null;
  const sourceCompanyId = typeof claims.sourceCompanyId === "string" ? claims.sourceCompanyId : null;
  const targetCompanyId = typeof claims.targetCompanyId === "string" ? claims.targetCompanyId : null;
  if (!requestId || !sourceCompanyId || !targetCompanyId) return null;
  if (
    expected
    && (expected.requestId !== requestId
      || expected.sourceCompanyId !== sourceCompanyId
      || expected.targetCompanyId !== targetCompanyId)
  ) {
    return null;
  }
  const key = capabilityKey({ requestId, sourceCompanyId, targetCompanyId });
  if (!key) return null;
  const expectedSignature = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!safeEqual(parts[2]!, expectedSignature)) return null;
  if (
    typeof claims.requesterType !== "string"
    || typeof claims.requesterId !== "string"
    || typeof claims.resourceType !== "string"
    || typeof claims.resourceRef !== "string"
    || typeof claims.action !== "string"
    || typeof claims.scopeHash !== "string"
    || typeof claims.iat !== "number"
    || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return claims as unknown as AdmCapabilityClaims;
}
