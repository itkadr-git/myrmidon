// packages/shared/src/adm-access-request-server.ts
//
// 1.7 COMPANY-BOUNDARIES (OPE-12766): server-side crypto for the ADM
// access-request capability tokens. Split from
// `myrmidon/adm-access-request.ts` so the browser-safe contract module stays
// out of the `node:crypto` import graph — the shared root barrel re-exports
// the myrmidon domain barrel, and any UI module importing `@myrmidon/shared`
// pulls every transitively reachable module into the vite dev graph
// (`node:crypto.createHash` is externalized there and crashes page eval).
// Server consumers import this module directly by subpath
// (`@myrmidon/shared/adm-access-request-server`), mirroring the
// `external-objects-server.ts` convention. Not exported from the root barrel.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, type AdmCapabilityClaims } from "./myrmidon/adm-access-request.js";

const CAPABILITY_TTL_FLOOR_SECONDS = 60;
const CAPABILITY_TTL_CEILING_SECONDS = 30 * 24 * 60 * 60;

function capabilityKey(claims: { sourceCompanyId: string; targetCompanyId: string; requestId: string }) {
  const master = process.env.AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || "";
  if (master.length === 0) return null;
  return createHmac(
    "sha256",
    master,
  )
    .update(`adm-access:${claims.sourceCompanyId}:${claims.targetCompanyId}:${claims.requestId}`)
    .digest();
}

function safeEqual(left: string, right: string): boolean {
  // Timing-safe: never inline a `===` here, signature comparison leaks.
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** base64url without padding, as required by JWT signing input parts. */
function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}


/** Hash of the requested scope: audit carries the hash, never raw values. */
export function admScopeHash(scope: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
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
