import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const cards = [
  { name: "Alpha", title: null, status: "active", metadata: { telegramAliases: ["unique", "shared"] }, adapterConfig: null },
  { name: "Beta", title: null, status: "active", metadata: { telegramAliases: ["shared"] }, adapterConfig: null },
  { name: "Gamma", title: null, status: "active", metadata: { telegramAliases: ["other"] }, adapterConfig: null },
];
const idsA = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const idsB = [
  "66666666-6666-4666-8666-666666666666",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

function fakeDb(ids: string[]) {
  const rows = cards.map((card, index) => ({ ...card, id: ids[index] }));
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const query = new PgDialect().sqlToQuery(condition);
      expect(query.sql).toMatch(/"company_id" = \$1/);
      expect(query.params).toEqual([companyId]);
      return { orderBy: async () => rows };
    },
  };
  return chain as unknown as Db;
}

describe("text address resolution under UUID bijections", () => {
  const cases = [
    {
      text: "@unique hello",
      expectedA: { kind: "resolved", addressee: { agentId: "11111111-1111-4111-8111-111111111111", displayName: "Alpha" } },
      expectedB: { kind: "resolved", addressee: { agentId: "66666666-6666-4666-8666-666666666666", displayName: "Alpha" } },
    },
    {
      text: "@shared hello",
      expectedA: { kind: "ambiguous", handle: "shared", candidates: [
        { agentId: "11111111-1111-4111-8111-111111111111", name: "Alpha" },
        { agentId: "22222222-2222-4222-8222-222222222222", name: "Beta" },
      ] },
      expectedB: { kind: "ambiguous", handle: "shared", candidates: [
        { agentId: "66666666-6666-4666-8666-666666666666", name: "Alpha" },
        { agentId: "44444444-4444-4444-8444-444444444444", name: "Beta" },
      ] },
    },
    { text: "@unknown hello", expectedA: { kind: "none" }, expectedB: { kind: "none" } },
  ];

  it.each(cases)("preserves $text except for mapped agent IDs", async ({ text, expectedA, expectedB }) => {
    const resultA = await resolveBridgeAddressee(fakeDb(idsA), { companyId, endpointAgentId: idsA[2]!, text });
    const resultB = await resolveBridgeAddressee(fakeDb(idsB), { companyId, endpointAgentId: idsB[2]!, text });
    expect(resultA).toEqual(expectedA);
    expect(resultB).toEqual(expectedB);
  });
});
