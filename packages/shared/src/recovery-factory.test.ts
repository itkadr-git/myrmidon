import { describe, expect, it } from "vitest";
import { ISSUE_RECOVERY_ACTION_KINDS } from "./constants.js";
import {
  buildRecoveryDedupeKey,
  DEFAULT_RECOVERY_SLA_MINUTES,
  RECOVERY_SLA_MINUTES_BY_KIND,
  recoveryFactoryRequestSchema,
  resolveRecoverySlaMinutes,
  type RecoveryFactoryRequest,
} from "./recovery-factory.js";

const validRequest = {
  kind: "ci_restart",
  sourceIssueId: "867fae9c-3303-42a8-95c4-23c80eaba058",
  dedupeKey: "ci_restart:source:cause",
  owner: { agentId: "62640ae6-658b-4cde-ba3a-b6a88e708df9" },
  slaMinutes: 30,
  nextCheckAt: "2026-10-25T05:00:00.000Z",
  evidence: { summary: "CI run 1234 failed on restart" },
} satisfies RecoveryFactoryRequest;

describe("recoveryFactoryRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(recoveryFactoryRequestSchema.parse(validRequest)).toEqual(validRequest);
  });

  it("accepts every recovery-factory kind", () => {
    const factoryKinds = [
      "ci_restart",
      "github_access",
      "branch_relay",
      "review_participant_restore",
      "workspace_myr_ws",
      "devbuild",
      "disk_space",
      "operator_action",
    ] as const;
    for (const kind of factoryKinds) {
      expect(() =>
        recoveryFactoryRequestSchema.parse({ ...validRequest, kind }),
      ).not.toThrow();
    }
    // and each is part of the shared kind list
    for (const kind of factoryKinds) {
      expect(ISSUE_RECOVERY_ACTION_KINDS).toContain(kind);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, kind: "injected_bad_kind" }),
    ).toThrow();
  });

  it("rejects a request without an owner", () => {
    const { owner: _owner, ...withoutOwner } = validRequest;
    expect(() => recoveryFactoryRequestSchema.parse(withoutOwner)).toThrow();
  });

  it("rejects a request with two owners at once", () => {
    const twoOwners = {
      ...validRequest,
      owner: { agentId: "a1", userId: "u1" },
    };
    expect(() => recoveryFactoryRequestSchema.parse(twoOwners)).toThrow();
  });

  it("rejects an owner with an unknown shape", () => {
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, owner: { robotId: "r1" } }),
    ).toThrow();
  });

  it("rejects a request without slaMinutes", () => {
    const { slaMinutes: _sla, ...withoutSla } = validRequest;
    expect(() => recoveryFactoryRequestSchema.parse(withoutSla)).toThrow();
  });

  it("rejects a non-positive slaMinutes", () => {
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, slaMinutes: 0 }),
    ).toThrow();
  });

  it("rejects a request without nextCheckAt", () => {
    const { nextCheckAt: _next, ...withoutNext } = validRequest;
    void _next;
    expect(() => recoveryFactoryRequestSchema.parse(withoutNext)).toThrow();
  });

  it("rejects a non-ISO nextCheckAt", () => {
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, nextCheckAt: "in 5 minutes" }),
    ).toThrow();
  });

  it("runbookRef is optional but must be non-empty when present", () => {
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, runbookRef: "runbooks/ci-restart" }),
    ).not.toThrow();
    expect(() =>
      recoveryFactoryRequestSchema.parse({ ...validRequest, runbookRef: "" }),
    ).toThrow();
  });
});

describe("buildRecoveryDedupeKey", () => {
  const base = { kind: "github_access" as const, scope: "company/instances", cause: "token expired" };

  it("returns the same key for repeated identical inputs", () => {
    expect(buildRecoveryDedupeKey(base)).toBe(buildRecoveryDedupeKey({ ...base }));
  });

  it("differs for different kind", () => {
    expect(buildRecoveryDedupeKey(base)).not.toBe(
      buildRecoveryDedupeKey({ ...base, kind: "ci_restart" }),
    );
  });

  it("differs for different scope", () => {
    expect(buildRecoveryDedupeKey(base)).not.toBe(
      buildRecoveryDedupeKey({ ...base, scope: "company/other" }),
    );
  });

  it("differs for different cause", () => {
    expect(buildRecoveryDedupeKey(base)).not.toBe(
      buildRecoveryDedupeKey({ ...base, cause: "403 forbidden" }),
    );
  });

  it("is deterministic across the process lifetime (no time component)", () => {
    const first = buildRecoveryDedupeKey(base);
    const second = buildRecoveryDedupeKey(base);
    expect(first).toBe(second);
    // 4×32-bit hex lanes: fixed-length opaque identity, no time component.
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("RECOVERY_SLA_MINUTES_BY_KIND", () => {
  const expectedSlas: Record<string, number> = {
    ci_restart: 30,
    github_access: 60,
    branch_relay: 60,
    review_participant_restore: 60,
    workspace_myr_ws: 120,
    devbuild: 120,
    disk_space: 60,
    operator_action: 120,
  };

  it("contains exact launch SLA minutes for every recovery-factory kind", () => {
    for (const [kind, expectedMinutes] of Object.entries(expectedSlas)) {
      expect(RECOVERY_SLA_MINUTES_BY_KIND[kind]).toBe(expectedMinutes);
      expect(DEFAULT_RECOVERY_SLA_MINUTES[kind]).toBe(expectedMinutes);
    }
  });

  it("resolveRecoverySlaMinutes returns baseline SLA", () => {
    for (const [kind, expectedMinutes] of Object.entries(expectedSlas)) {
      expect(resolveRecoverySlaMinutes(kind)).toBe(expectedMinutes);
    }
  });

  it("resolveRecoverySlaMinutes applies overrides when provided", () => {
    expect(resolveRecoverySlaMinutes("ci_restart", { ci_restart: 15 })).toBe(15);
    expect(resolveRecoverySlaMinutes("ci_restart", { github_access: 90 })).toBe(30);
  });

  it("resolveRecoverySlaMinutes falls back to default 60 for unknown kind", () => {
    expect(resolveRecoverySlaMinutes("unknown_recovery_kind")).toBe(60);
  });
});
