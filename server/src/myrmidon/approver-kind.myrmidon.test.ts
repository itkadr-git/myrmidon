// myrmidon(1.6.6 K-3): the grade a board actor presents to the rule gates.

import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { approverKindFromRequest } from "./approver-kind.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";

function reqOf(actor: unknown): Request {
  return { actor } as unknown as Request;
}

function withRole(membershipRole: string | null, status = "active") {
  return reqOf({ type: "board", source: "session", memberships: [{ companyId: COMPANY, status, membershipRole }] });
}

describe("approverKindFromRequest", () => {
  it("maps owner, admin and operator memberships to their grade", () => {
    expect(approverKindFromRequest(withRole("owner"), COMPANY)).toBe("owner");
    expect(approverKindFromRequest(withRole("admin"), COMPANY)).toBe("admin");
    expect(approverKindFromRequest(withRole("operator"), COMPANY)).toBe("operator");
  });

  it("the instance admin and the local implicit board are the owner", () => {
    expect(approverKindFromRequest(reqOf({ type: "board", source: "session", isInstanceAdmin: true }), COMPANY)).toBe("owner");
    expect(approverKindFromRequest(reqOf({ type: "board", source: "local_implicit" }), COMPANY)).toBe("owner");
  });

  it("has no grade for a viewer, an unknown role, a missing or inactive membership, an agent", () => {
    expect(approverKindFromRequest(withRole("viewer"), COMPANY)).toBeNull();
    expect(approverKindFromRequest(withRole("janitor"), COMPANY)).toBeNull();
    expect(approverKindFromRequest(withRole(null), COMPANY)).toBeNull();
    expect(approverKindFromRequest(withRole("owner", "suspended"), COMPANY)).toBeNull();
    expect(approverKindFromRequest(reqOf({ type: "board", source: "session", memberships: [] }), COMPANY)).toBeNull();
    expect(approverKindFromRequest(reqOf({ type: "agent", source: "agent_key", agentId: "a" }), COMPANY)).toBeNull();
    expect(approverKindFromRequest(reqOf(undefined), COMPANY)).toBeNull();
  });
});
