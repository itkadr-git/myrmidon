// packages/shared/src/myrmidon/adm-access-request.ts
//
// 1.7 COMPANY-BOUNDARIES (OPE-12766): typed contract for the single
// cross-company control channel described in ADR-0052. A company under
// isolation may ask ADM for a capability; the request carries scope,
// justification, TTL, idempotency approval key and correlation id, then ADM
// decides (approve/deny), issues an audience-bound short-lived capability,
// and every transition is audited. Raw tokens, secret values and arbitrary
// URLs are rejected by schema; the capability itself is HMAC-signed and
// re-checked against live request state immediately before any effect.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** The ADM control-plane company is identified by explicit configuration. */
export const ADM_ACCESS_REQUEST_TYPE = "adm_access_request" as const;
export const ADM_COMPANY_ID_ENV = "ADM_COMPANY_ID";

/** Resource types a company may ask ADM to act on. Deny-by-default closed list. */
export const admResourceTypes = [
  "skill",
  "secret",
  "connection",
  "project",
  "budget",
  "memory",
  "tool",
] as const;

export type AdmResourceType = (typeof admResourceTypes)[number];

/** Actions a company may request. Closed list — anything else is denied by schema. */
export const admAccessActions = [
  "read_metadata",
  "invoke_tool",
  "grant_capability",
  "query_aggregate",
  "bounds",
] as const;

export type AdmAccessAction = (typeof admAccessActions)[number];

/** Request lifecycle states. `expired` is computed at decision time, never stored directly. */
export const admRequestStatuses = [
  "pending",
  "approved",
  "denied",
  "expired",
  "revoked",
] as const;

export type AdmRequestStatus = (typeof admRequestStatuses)[number];

export interface RedactedAdmRequest {
  requestId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  resourceType: string;
  resourceRef: string;
  action: string;
  status: string;
  scopeHash: string;
  justification: string;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

/**
 * Allowlist for `requestedScope`. ADR-0052: "raw tokens, secret values and
 * arbitrary URLs are forbidden by schema", so the schema below rejects every
 * key outside this list and every string value that looks like a credential
 * or a URL. Values carry names/labels/limits, never material to authenticate.
 */
export const admScopeAllowlist = [
  "resourceKey",
  "operationKind",
  "aggregateName",
  "resourcePath",
  "projectArea",
  "budgetArea",
  "operationTimeoutSeconds",
  "redactedProjection",
  "notes",
  "referenceKey",
] as const;

/**
 * Strings that must never appear as a scope value (case-insensitive): they
 * signal credential material or smuggled network targets. ADR-0052 forbids
 * raw tokens, secret values and arbitrary URLs at the schema level.
 */
const FORBIDDEN_SCOPE_KEY_PATTERNS: RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /credential/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /privatekey/i,
  /private_key/i,
  /bearer/i,
  /cookie/i,
  /session/i,
  /url/i,
  /uri/i,
  /endpoint/i,
  /host/i,
];

const URL_LIKE_VALUE_PATTERN =
  /(?:^|[\s(])?(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.)\S+/i;

/** Bare domains inside a value also smuggle network targets. */
const BARE_DOMAIN_PATTERN = /(?:^|[\s(])[a-z0-9][a-z0-9.-]*\.(?:com|net|org|io|dev|ru|club|ai|co)(?:\/|\s|$)/i;

/** True when a string looks like a URL anywhere inside it. */
function looksLikeUrl(value: string): boolean {
  return URL_LIKE_VALUE_PATTERN.test(value) || BARE_DOMAIN_PATTERN.test(value);
}

/**
 * True when a scope payload smuggles credential material or a network
 * target. Rejects forbidden key names anywhere in the tree and URL-shaped
 * string values. Public so the server can reuse the exact contract check.
 */
export function isForbiddenScopePayload(value: unknown): boolean {
  if (typeof value === "string") {
    return looksLikeUrl(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => isForbiddenScopePayload(item));
  }
  if (value === null || typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SCOPE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      return true;
    }
    if (isForbiddenScopePayload(nested)) return true;
  }
  return false;
}

const ALLOWED_SCOPE_KEYS = new Set<string>(admScopeAllowlist);

/** Scope values are plain, shallowly-nested records of scalars. */
const scopeValueSchema: z.ZodType<string | number | boolean | null | string[]> = z.union([
  z.string().max(256),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(256)).max(16),
]);

export const admAccessRequestScopeSchema = z
  .record(z.string().max(64), scopeValueSchema)
  .refine((scope) => Object.keys(scope).every((key) => ALLOWED_SCOPE_KEYS.has(key)), {
    message: "requestedScope contains keys outside the ADM allowlist",
  })
  .refine((scope) => Object.keys(scope).length <= 16, {
    message: "requestedScope must contain at most 16 keys",
  })
  .refine((scope) => !isForbiddenScopePayload(scope), {
    message:
      "requestedScope must not contain tokens, secrets, credentials, URLs or endpoints",
  });

export const createAdmAccessRequestSchema = z
  .object({
    targetCompanyId: z.string().uuid(),
    resourceType: z.enum(admResourceTypes),
    resourceRef: z.string().min(1).max(256),
    action: z.enum(admAccessActions),
    justification: z.string().min(1).max(2000),
    requestedScope: admAccessRequestScopeSchema,
    ttlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
    idempotencyKey: z.string().min(8).max(256),
    correlationRunId: z.string().max(256).nullable().optional(),
  })
  .strict();

export type CreateAdmAccessRequestInput = z.infer<typeof createAdmAccessRequestSchema>;

export const decideAdmAccessRequestSchema = z
  .object({
    decision: z.enum(["approved", "denied"]),
    reason: z.string().max(2000).optional(),
    ttlSeconds: z.number().int().min(60).max(30 * 24 * 60 * 60).optional(),
  })
  .strict();

export type DecideAdmAccessRequestInput = z.infer<typeof decideAdmAccessRequestSchema>;

export const revokeAdmAccessRequestSchema = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .strict();

export type RevokeAdmAccessRequestInput = z.infer<typeof revokeAdmAccessRequestSchema>;

export const executeAdmCapabilitySchema = z
  .object({
    capabilityToken: z.string().min(16).max(4096),
  })
  .strict();

export type ExecuteAdmCapabilityInput = z.infer<typeof executeAdmCapabilitySchema>;

/** Stable canonical JSON used for scope hashing and capability signing. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
}

/** Hash of the requested scope: audit carries the hash, never raw values. */
export function admScopeHash(scope: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(scope)).digest("hex");
}

export interface AdmCapabilityClaims {
  requestId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  requesterType: string;
  requesterId: string;
  resourceType: string;
  resourceRef: string;
  action: string;
  scopeHash: string;
  iat: number;
  exp: number;
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

/** Redacted projection: request fields safe to show cross-company. */
export function redactedAdmRequestProjection(input: {
  requestId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  resourceType: string;
  resourceRef: string;
  action: string;
  status: string;
  scopeHash: string;
  justification: string;
  createdAt: Date | string;
  decidedAt: Date | string | null;
  expiresAt: Date | string | null;
}): RedactedAdmRequest {
  return {
    requestId: input.requestId,
    sourceCompanyId: input.sourceCompanyId,
    targetCompanyId: input.targetCompanyId,
    resourceType: input.resourceType,
    resourceRef: input.resourceRef,
    action: input.action,
    status: input.status,
    scopeHash: input.scopeHash,
    justification: input.justification,
    createdAt: input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt,
    decidedAt: input.decidedAt
      ? input.decidedAt instanceof Date
        ? input.decidedAt.toISOString()
        : input.decidedAt
      : null,
    expiresAt: input.expiresAt
      ? input.expiresAt instanceof Date
        ? input.expiresAt.toISOString()
        : input.expiresAt
      : null,
  };
}
