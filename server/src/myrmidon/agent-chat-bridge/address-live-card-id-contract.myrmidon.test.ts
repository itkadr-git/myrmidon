import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

interface AgentRow {
  id: string;
  name: string;
  title: string | null;
  status: string;
  metadata: unknown;
  adapterConfig: unknown;
}

const companyA = "company-a";
const companyB = "company-b";
const live: AgentRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Live Agent",
  title: null,
  status: "idle",
  metadata: {},
  adapterConfig: {},
};
const other: AgentRow = {
  ...live,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Other Company",
};
const targetId = "33333333-3333-4333-8333-333333333333";

function fakeDb(rowsByCompany: Record<string, AgentRow[]>) {
  const conditions: SQL[] = [];
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      conditions.push(condition);
      const params = new PgDialect().sqlToQuery(condition).params;
      const companyId = params[0];
      return {
        orderBy() {
          return Promise.resolve(typeof companyId === "string" ? rowsByCompany[companyId] ?? [] : []);
        },
      };
    },
  };
  return { db: chain as unknown as Db, conditions };
}

function address(db: Db, companyId: string, id: string) {
  return resolveBridgeAddressee(db, { companyId, text: `agent://${id}`, endpointAgentId: live.id });
}

const hiddenCases: Array<[string, Partial<AgentRow>]> = [
  ["paused", { status: "paused" }],
  ["terminated", { status: "terminated" }],
  ["pending approval", { status: "pending_approval" }],
  ["retired name", { name: "Agent-retired" }],
  ["plugin marker", { metadata: { pluginManagedAgent: true } }],
  ["false plugin marker", { metadata: { pluginManagedAgent: false } }],
  ["managed resource marker", { metadata: { paperclipManagedResource: {} } }],
  ["false managed resource marker", { metadata: { paperclipManagedResource: false } }],
];

describe("bridge exact ID live-card visibility", () => {
  it.each(hiddenCases)("rejects %s while resolving the live card", async (_label, change) => {
    const hidden = { ...live, id: targetId, name: "Hidden Agent", ...change };
    const { db, conditions } = fakeDb({ [companyA]: [hidden, live], [companyB]: [other] });
    expect(await address(db, companyA, targetId)).toEqual({ kind: "invalid_id" });
    expect(await address(db, companyA, live.id)).toEqual({
      kind: "resolved", addressee: { agentId: live.id, displayName: live.name },
    });
    expect(conditions.map((condition) => new PgDialect().sqlToQuery(condition).params)).toEqual([
      [companyA], [companyA],
    ]);
  });

  it.each([
    ["absent markers", {}],
    ["null plugin marker", { pluginManagedAgent: null }],
    ["null managed resource marker", { paperclipManagedResource: null }],
    ["both null markers", { pluginManagedAgent: null, paperclipManagedResource: null }],
  ])("resolves a live card with %s", async (_label, metadata) => {
    const target = { ...live, id: targetId, name: "Target Agent", metadata };
    const { db } = fakeDb({ [companyA]: [target, live], [companyB]: [other] });
    expect(await address(db, companyA, targetId)).toEqual({
      kind: "resolved", addressee: { agentId: targetId, displayName: target.name },
    });
  });

  it("uses the requested company for the ID lookup", async () => {
    const { db, conditions } = fakeDb({ [companyA]: [live], [companyB]: [other] });
    expect(await address(db, companyA, other.id)).toEqual({ kind: "invalid_id" });
    expect(await address(db, companyB, other.id)).toEqual({
      kind: "resolved", addressee: { agentId: other.id, displayName: other.name },
    });
    expect(await address(db, companyB, live.id)).toEqual({ kind: "invalid_id" });
    for (const [index, company] of [companyA, companyB, companyB].entries()) {
      const condition = conditions[index];
      expect(condition).toBeDefined();
      if (!condition) throw new Error("Missing company condition");
      const query = new PgDialect().sqlToQuery(condition);
      expect(query.sql).toMatch(/"company_id" = \$1/);
      expect(query.params).toEqual([company]);
    }
  });
});
