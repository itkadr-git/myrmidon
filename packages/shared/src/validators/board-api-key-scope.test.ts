import { describe, expect, it } from "vitest";
import {
  BOARD_API_KEY_ROLE_SCOPE_KINDS,
  BOARD_API_KEY_SCOPE_KINDS,
  boardApiKeyScopeSchema,
  createBoardApiKeySchema,
  isMonitoringLinkScope,
  monitoringLinkScopeSchema,
  normalizeBoardApiKeyScope,
} from "./access.js";

// Enforcement behaviour (boardApiKeyScopeAllows / middleware) is covered by
// server/src/__tests__/board-key-scope-middleware.test.ts.

describe("board API key scope validator (myrmidon ROLE-SCOPED-TOKENS)", () => {
  it("accepts every documented scope kind", () => {
    for (const kind of BOARD_API_KEY_SCOPE_KINDS) {
      // monitoring_link carries its policy fields, so a bare kind cannot stand
      // for it; it is covered by its own block below.
      if (kind === "monitoring_link") continue;
      expect(boardApiKeyScopeSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it("rejects unknown scope kinds", () => {
    expect(boardApiKeyScopeSchema.safeParse({ kind: "superuser" }).success).toBe(false);
    // Non-strict object: unknown extra keys are stripped, not rejected — same
    // tolerance as the vendor's agent key scope schemas' parent objects.
    const parsed = boardApiKeyScopeSchema.safeParse({ kind: "full", extra: 1 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ kind: "full" });
  });

  it("normalizes a present but unreadable scope to least privilege", () => {
    // An absent scope keeps its historical full access...
    expect(normalizeBoardApiKeyScope(null)).toEqual({ kind: "full" });
    expect(normalizeBoardApiKeyScope(undefined)).toEqual({ kind: "full" });
    // ...but a scope that is there and cannot be read must not widen to full:
    // a malformed role key becoming an operator key is the escalation this
    // change exists to close (myrmidon 1.6.6 MONITORING E).
    expect(normalizeBoardApiKeyScope({ kind: "bogus" })).toEqual({ kind: "read_only" });
    expect(normalizeBoardApiKeyScope({ kind: "monitoring_link" })).toEqual({ kind: "read_only" });
    expect(normalizeBoardApiKeyScope("read_only")).toEqual({ kind: "read_only" });
  });

  it("createBoardApiKeySchema keeps scope optional and validates kinds", () => {
    // No default: absent scope must stay absent so client wire contracts
    // (CLI payloads parsed through this schema) are unchanged.
    expect(createBoardApiKeySchema.parse({})).not.toHaveProperty("scope");
    expect(createBoardApiKeySchema.parse({ name: "x" })).not.toHaveProperty("scope");
    expect(createBoardApiKeySchema.parse({ name: "x", scope: { kind: "read_only" } }).scope).toEqual({
      kind: "read_only",
    });
    expect(
      createBoardApiKeySchema.safeParse({ name: "x", scope: { kind: "nope" } }).success,
    ).toBe(false);
  });
});

// myrmidon(1.6.6 MONITORING E): the linking components' minimal-rights key.
describe("monitoring link scope (myrmidon 1.6.6 MONITORING E)", () => {
  const companyId = "2870b911-483a-4091-9f15-183841811143";

  it("accepts a link scope and defaults the no-pulse threshold", () => {
    const parsed = monitoringLinkScopeSchema.parse({
      kind: "monitoring_link",
      linkKey: "zabbix-aggregator",
      companyId,
    });
    expect(parsed.staleAfterSec).toBe(480);
    expect(isMonitoringLinkScope(parsed)).toBe(true);
    // The threshold stays inside a day and above a minute, so a typo cannot
    // either mute a link for a week or alarm-flap the board.
    expect(
      monitoringLinkScopeSchema.safeParse({
        kind: "monitoring_link",
        linkKey: "x",
        companyId,
        staleAfterSec: 30,
      }).success,
    ).toBe(false);
    expect(
      monitoringLinkScopeSchema.safeParse({
        kind: "monitoring_link",
        linkKey: "x",
        companyId,
        staleAfterSec: 604_800,
      }).success,
    ).toBe(false);
  });

  it("requires the link identity, not just the kind", () => {
    expect(boardApiKeyScopeSchema.safeParse({ kind: "monitoring_link" }).success).toBe(false);
    // The guard the middleware, authz and the pulse endpoint share is not a
    // discriminant check: a link scope without its policy fields is not one.
    expect(isMonitoringLinkScope({ kind: "monitoring_link" } as never)).toBe(false);
    expect(
      isMonitoringLinkScope({ kind: "monitoring_link", linkKey: "zabbix", companyId } as never),
    ).toBe(true);
    expect(
      boardApiKeyScopeSchema.safeParse({ kind: "monitoring_link", linkKey: "  ", companyId }).success,
    ).toBe(false);
    expect(
      boardApiKeyScopeSchema.safeParse({ kind: "monitoring_link", linkKey: "x", companyId: "nope" })
        .success,
    ).toBe(false);
  });

  it("is not a role scope, so the operator-scope list stays unchanged", () => {
    expect(BOARD_API_KEY_ROLE_SCOPE_KINDS).not.toContain("monitoring_link");
    expect(isMonitoringLinkScope({ kind: "read_only" })).toBe(false);
    expect(isMonitoringLinkScope(null)).toBe(false);
  });
});
