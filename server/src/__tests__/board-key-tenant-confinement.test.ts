// server/src/__tests__/board-key-tenant-confinement.test.ts
//
// myrmidon(1.6.6 MONITORING E): "minimal rights" is not only about which verbs
// a linking component may use, it is also about which company those verbs land
// in. A link key is issued for one company; its authority must not follow its
// owner user's membership list into other tenants, or a leaked aggregator key
// would read and write another company's board.
//
// This pins the two helpers every company-scoped route goes through:
// `assertCompanyAccess` (write paths, and the explicit gate in route handlers)
// and `hasCompanyAccess` (the by-id lookup that decides 404 vs. found).

import { describe, expect, it } from "vitest";
import { assertCompanyAccess, hasCompanyAccess } from "../routes/authz.js";

// Real company ids are GUIDs: the scope schema validates companyId as one, so
// a link scope carrying anything else is itself malformed and degrades.
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

function actor(overrides: Record<string, unknown>) {
  return {
    type: "board",
    userId: "user-1",
    source: "board_key",
    keyId: "key-1",
    // The owner user is a member of both companies: without the link rule,
    // the key would inherit exactly this list.
    companyIds: [COMPANY_A, COMPANY_B],
    memberships: [],
    ...overrides,
  } as any;
}

const linkActor = (companyId: string) =>
  actor({
    boardKeyScope: {
      kind: "monitoring_link",
      linkKey: "zabbix-aggregator",
      companyId,
      staleAfterSec: 480,
      alertAssigneeAgentId: null,
    },
  });

describe("monitoring link key tenant confinement", () => {
  it("allows a link key inside its own company and refuses every other", () => {
    const req = { actor: linkActor(COMPANY_A), method: "GET" } as any;
    expect(() => assertCompanyAccess(req, COMPANY_A)).not.toThrow();
    expect(() => assertCompanyAccess(req, COMPANY_B)).toThrowError(
      /Monitoring link key cannot access another company/,
    );
  });

  it("answers the by-id lookup with a denial, so routes emit 404, not 403", () => {
    const req = { actor: linkActor(COMPANY_A), method: "GET" } as any;
    expect(hasCompanyAccess(req, COMPANY_A)).toBe(true);
    // A false here is what turns a cross-tenant issue lookup into the same
    // "not found" a missing id gets: no existence oracle.
    expect(hasCompanyAccess(req, COMPANY_B)).toBe(false);
  });

  it("leaves every other board key on the old membership rule", () => {
    const full = actor({ boardKeyScope: { kind: "full" } });
    expect(hasCompanyAccess({ actor: full, method: "GET" } as any, COMPANY_B)).toBe(true);
    expect(() =>
      assertCompanyAccess({ actor: full, method: "GET" } as any, COMPANY_B),
    ).not.toThrow();
  });

  it("leaves a link scope with no company of its own unable to reach anything", () => {
    // A stored scope that lost its companyId must fail closed rather than fall
    // back to the owner user's memberships.
    const orphan = actor({
      boardKeyScope: {
        kind: "monitoring_link",
        linkKey: "zabbix-aggregator",
        companyId: "",
        staleAfterSec: 480,
        alertAssigneeAgentId: null,
      },
    });
    expect(hasCompanyAccess({ actor: orphan, method: "GET" } as any, COMPANY_A)).toBe(false);
  });

  it("does not confine a session actor or an agent key", () => {
    const session = actor({ source: "session" });
    expect(hasCompanyAccess({ actor: session, method: "GET" } as any, COMPANY_B)).toBe(true);
    const agent = { type: "agent", agentId: "a-1", companyId: COMPANY_A, source: "agent_key" } as any;
    expect(hasCompanyAccess({ actor: agent, method: "GET" } as any, COMPANY_A)).toBe(true);
    expect(hasCompanyAccess({ actor: agent, method: "GET" } as any, COMPANY_B)).toBe(false);
  });
});