import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B1 = "22222222-2222-4222-8222-222222222222";
const ID_B2 = "33333333-3333-4333-8333-333333333333";
const ID_B3 = "44444444-4444-4444-8444-444444444444";
const ENDPOINT = "99999999-9999-4999-8999-999999999999";

function row(id: string, name: string) {
  return Object.freeze({
    id, name, title: null, status: "active",
    metadata: Object.freeze({ telegramAliases: Object.freeze(["dispatch"]) }),
    adapterConfig: null,
  });
}
const A = row(ID_A, "Alpha");
const B1 = row(ID_B1, "Bravo One");
const B2 = row(ID_B2, "Bravo Two");
const B3 = row(ID_B3, "Bravo Three");
const rows = (agent: typeof A) => Object.freeze([agent]);

function fakeDb() {
  const rowsByCompany: Record<string, readonly typeof A[]> = {
    [COMPANY_A]: rows(A), [COMPANY_B]: rows(B1),
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const query = new PgDialect().sqlToQuery(condition);
      queries.push(query);
      const company = query.params[0];
      return { orderBy: async () => typeof company === "string" ? rowsByCompany[company] ?? [] : [] };
    },
  };
  return { db: chain as unknown as Db, rowsByCompany, queries };
}

const resolved = (agentId: string, displayName: string) => ({
  kind: "resolved", addressee: { agentId, displayName },
});

describe("company address catalog reload", () => {
  it("isolates alternating companies and reads each replacement on the same handle", async () => {
    const { db, rowsByCompany, queries } = fakeDb();
    const check = async (companyId: string, text: string, expected: object) => {
      const before = queries.length;
      const result = await resolveBridgeAddressee(db, { companyId, text, endpointAgentId: ENDPOINT });
      expect(result).toEqual(expected);
      expect(queries).toHaveLength(before + 1);
      expect(queries[before]?.sql).toMatch(/"company_id" = \$1/);
      expect(queries[before]?.params).toEqual([companyId]);
    };
    const transitions = [
      { company: COMPANY_A, own: ID_A, foreign: ID_B1, name: "Alpha" },
      { company: COMPANY_B, own: ID_B1, foreign: ID_A, name: "Bravo One" },
      { company: COMPANY_A, own: ID_A, foreign: ID_B1, name: "Alpha" },
      { company: COMPANY_B, own: ID_B1, foreign: ID_A, name: "Bravo One" },
    ];
    for (const step of transitions) {
      await check(step.company, "@dispatch hello", resolved(step.own, step.name));
      await check(step.company, `agent://${step.own}`, resolved(step.own, step.name));
      await check(step.company, `agent://${step.foreign}`, { kind: "invalid_id" });
    }
    for (const next of [
      { agent: B2, id: ID_B2, name: "Bravo Two", previous: ID_B1 },
      { agent: B3, id: ID_B3, name: "Bravo Three", previous: ID_B2 },
    ]) {
      rowsByCompany[COMPANY_B] = rows(next.agent);
      await check(COMPANY_A, "@dispatch hello", resolved(ID_A, "Alpha"));
      await check(COMPANY_A, `agent://${next.id}`, { kind: "invalid_id" });
      await check(COMPANY_B, "@dispatch hello", resolved(next.id, next.name));
      await check(COMPANY_B, `agent://${next.id}`, resolved(next.id, next.name));
      await check(COMPANY_B, `agent://${next.previous}`, { kind: "invalid_id" });
      await check(COMPANY_B, `agent://${ID_A}`, { kind: "invalid_id" });
      await check(COMPANY_B, "@missing", { kind: "none" });
    }
    expect(rowsByCompany[COMPANY_A]).toEqual([A]);
    expect(rowsByCompany[COMPANY_B]).toEqual([B3]);
  });
});
