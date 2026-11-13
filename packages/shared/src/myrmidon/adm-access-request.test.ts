import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  canonicalJson,
  createAdmAccessRequestSchema,
  decideAdmAccessRequestSchema,
  executeAdmCapabilitySchema,
  isForbiddenScopePayload,
  redactedAdmRequestProjection,
  revokeAdmAccessRequestSchema,
} from "./adm-access-request.js";
import {
  admScopeHash,
  createAdmCapabilityToken,
  verifyAdmCapabilityToken,
} from "./adm-access-request-crypto.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";

const validCreateInput = {
  targetCompanyId: TARGET,
  resourceType: "skill" as const,
  resourceRef: "skill:atlas-report",
  action: "read_metadata" as const,
  justification: "Cross-company report needs the skill catalog metadata",
  requestedScope: { resourceKey: "atlas-report" },
  ttlSeconds: 3600,
  idempotencyKey: "idem-key-0001",
  correlationRunId: null as string | null,
};

describe("createAdmAccessRequestSchema", () => {
  it("accepts a clean allowlisted request", () => {
    expect(createAdmAccessRequestSchema.safeParse(validCreateInput).success).toBe(true);
  });

  it("rejects unknown resource types and actions", () => {
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        resourceType: "wallet",
      }).success,
    ).toBe(false);
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        action: "drop_table",
      }).success,
    ).toBe(false);
  });

  it("rejects secrets, tokens and URLs in requestedScope", () => {
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        requestedScope: { apiToken: "super-secret-value" },
      }).success,
    ).toBe(false);
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        requestedScope: { notes: "call https://evil.example.com/steal" },
      }).success,
    ).toBe(false);
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        requestedScope: { callback: "//internal-service.local/api" },
      }).success,
    ).toBe(false);
  });

  it("rejects oversized scope payloads and unknown extra fields", () => {
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        requestedScope: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`k${index}`, `v${index}`]),
        ),
      }).success,
    ).toBe(false);
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        extraField: true,
      }).success,
    ).toBe(false);
  });

  it("rejects short idempotency keys and missing justification", () => {
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        idempotencyKey: "short",
      }).success,
    ).toBe(false);
    expect(
      createAdmAccessRequestSchema.safeParse({
        ...validCreateInput,
        justification: "",
      }).success,
    ).toBe(false);
  });
});

describe("isForbiddenScopePayload", () => {
  it("detects credential keys nested at any depth", () => {
    expect(isForbiddenScopePayload({ nested: { sessionToken: "x" } })).toBe(true);
    expect(isForbiddenScopePayload({ list: [{ authorization: "Bearer x" }] })).toBe(true);
    expect(isForbiddenScopePayload({ endpointUrl: "http://x" })).toBe(true);
  });

  it("allows plain operational keys", () => {
    expect(isForbiddenScopePayload({ resourceKey: "atlas", notes: "monthly rollup" })).toBe(false);
  });
});

describe("canonicalJson and admScopeHash", () => {
  it("is key-order independent", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(admScopeHash({ a: 1, b: 2 })).toBe(admScopeHash({ b: 2, a: 1 }));
  });

  it("changes when scope content changes", () => {
    expect(admScopeHash({ a: 1 })).not.toBe(admScopeHash({ a: 2 }));
  });
});

describe("decide/revoke/execute schemas", () => {
  it("validates decision payloads", () => {
    expect(decideAdmAccessRequestSchema.safeParse({ decision: "approved", ttlSeconds: 600 }).success).toBe(true);
    expect(decideAdmAccessRequestSchema.safeParse({ decision: "postpone" }).success).toBe(false);
    expect(revokeAdmAccessRequestSchema.safeParse({ reason: "done" }).success).toBe(true);
    expect(executeAdmCapabilitySchema.safeParse({ capabilityToken: "x".repeat(64) }).success).toBe(true);
    expect(executeAdmCapabilitySchema.safeParse({ capabilityToken: "" }).success).toBe(false);
  });
});

describe("capability tokens", () => {
  const issueInput = {
    requestId: "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f",
    sourceCompanyId: SOURCE,
    targetCompanyId: TARGET,
    requesterType: "agent",
    requesterId: "33333333-3333-4333-8333-333333333333",
    resourceType: "skill",
    resourceRef: "skill:atlas-report",
    action: "read_metadata",
    scopeHash: admScopeHash({ resourceKey: "atlas-report" }),
    ttlSeconds: 300,
  };

  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.AGENT_JWT_SECRET;
    process.env.AGENT_JWT_SECRET = "test-signing-secret-value-0123456789";
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.AGENT_JWT_SECRET;
    } else {
      process.env.AGENT_JWT_SECRET = previousSecret;
    }
  });

  it("round-trips a valid token for the right audience", () => {
    const issued = createAdmCapabilityToken(issueInput);
    expect(issued).not.toBeNull();
    const claims = verifyAdmCapabilityToken(issued!.token, {
      requestId: issueInput.requestId,
      sourceCompanyId: SOURCE,
      targetCompanyId: TARGET,
    });
    expect(claims).not.toBeNull();
    expect(claims!.resourceType).toBe("skill");
    expect(claims!.action).toBe("read_metadata");
    expect(claims!.scopeHash).toBe(issueInput.scopeHash);
  });

  it("rejects the token for a different audience pair", () => {
    const issued = createAdmCapabilityToken(issueInput);
    const claims = verifyAdmCapabilityToken(issued!.token, {
      requestId: issueInput.requestId,
      sourceCompanyId: "99999999-9999-4999-8999-999999999999",
      targetCompanyId: TARGET,
    });
    expect(claims).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const issued = createAdmCapabilityToken(issueInput)!;
    const [header, payload, signature] = issued.token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        requestId: issueInput.requestId,
        sourceCompanyId: SOURCE,
        targetCompanyId: TARGET,
        requesterType: "agent",
        requesterId: "33333333-3333-4333-8333-333333333333",
        resourceType: "secret",
        resourceRef: "secret:prod-db",
        action: "grant_capability",
        scopeHash: issueInput.scopeHash,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 9999,
      }),
      "utf8",
    ).toString("base64url");
    const forged = `${header}.${forgedPayload}.${signature}`;
    expect(
      verifyAdmCapabilityToken(forged, {
        requestId: issueInput.requestId,
        sourceCompanyId: SOURCE,
        targetCompanyId: TARGET,
      }),
    ).toBeNull();
  });

  it("rejects expired tokens", () => {
    const issued = createAdmCapabilityToken({ ...issueInput, ttlSeconds: 60 })!;
    const [header, payload] = issued.token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.exp = Math.floor(Date.now() / 1000) - 10;
    claims.iat = claims.exp - 60;
    const reSignedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    // Re-sign with the real key to isolate the expiry check.
    const key = createHmac("sha256", process.env.AGENT_JWT_SECRET!)
      .update(`adm-access:${SOURCE}:${TARGET}:${issueInput.requestId}`)
      .digest();
    const signature = createHmac("sha256", key).update(`${header}.${reSignedPayload}`).digest("base64url");
    const expired = `${header}.${reSignedPayload}.${signature}`;
    expect(
      verifyAdmCapabilityToken(expired, {
        requestId: issueInput.requestId,
        sourceCompanyId: SOURCE,
        targetCompanyId: TARGET,
      }),
    ).toBeNull();
  });

  it("returns null when no signing secret is configured", () => {
    delete process.env.AGENT_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    expect(createAdmCapabilityToken(issueInput)).toBeNull();
  });
});

describe("redactedAdmRequestProjection", () => {
  it("exposes no scope values or capability material", () => {
    const projection = redactedAdmRequestProjection({
      requestId: "req-1",
      sourceCompanyId: SOURCE,
      targetCompanyId: TARGET,
      resourceType: "skill",
      resourceRef: "skill:atlas-report",
      action: "read_metadata",
      status: "approved",
      scopeHash: "abc123",
      justification: "report",
      createdAt: new Date("2026-11-12T00:00:00Z"),
      decidedAt: new Date("2026-11-12T01:00:00Z"),
      expiresAt: new Date("2026-11-12T02:00:00Z"),
    });
    expect(Object.keys(projection)).not.toContain("requestedScope");
    expect(Object.keys(projection)).not.toContain("capabilityToken");
    expect(projection.scopeHash).toBe("abc123");
  });
});
