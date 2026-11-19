import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
type Source = "metadata" | "adapterConfig" | "name" | "title";
type Card = { id: string; name: string; title: string | null; status: string; metadata: { telegramAliases: string[] }; adapterConfig: { telegramAliases: string[] } };

function card(index: number, source: Source, name: string): Card {
  const row: Card = { id: ids[index]!, name, title: null, status: "active", metadata: { telegramAliases: [] }, adapterConfig: { telegramAliases: [] } };
  if (source === "name") row.name = "Shared";
  else if (source === "title") row.title = "Shared";
  else row[source].telegramAliases.push("Shared");
  return row;
}

function fakeDb(rows: Card[]): Db {
  let reads = 0;
  const chain = {
    select() { reads++; expect(reads).toBe(1); return chain; },
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

async function resolve(rows: Card[]) {
  return resolveBridgeAddressee(fakeDb(rows), { companyId, endpointAgentId: ids[2]!, text: "@shared hello" });
}

async function expectAmbiguous(rows: Card[], expected: Array<{ agentId: string; name: string }>) {
  const result = await resolve(rows);
  expect(result.kind).toBe("ambiguous");
  if (result.kind !== "ambiguous") throw new Error("expected ambiguity");
  expect(result.handle).toBe("shared");
  expect(result.candidates).toHaveLength(expected.length);
  expect(new Set(result.candidates.map(({ agentId, name }) => JSON.stringify([agentId, name])))).toEqual(
    new Set(expected.map(({ agentId, name }) => JSON.stringify([agentId, name]))),
  );
}

describe("bridge address cross-field collision matrix", () => {
  const sources: Source[] = ["metadata", "adapterConfig", "name", "title"];
  const pairs = sources.flatMap((left) => sources.map((right) => ({ left, right })));
  it.each(pairs)("retains both UUIDs for $left / $right", async ({ left, right }) => {
    const a = card(0, left, "Alpha");
    const b = card(1, right, "Beta");
    await expectAmbiguous([a, b], [{ agentId: ids[0]!, name: a.name }, { agentId: ids[1]!, name: b.name }]);
  });

  it("deduplicates one UUID across every source", async () => {
    const row = card(0, "name", "Alpha");
    row.title = "Shared";
    row.metadata.telegramAliases = ["Shared", "shared"];
    row.adapterConfig.telegramAliases = ["shared"];
    expect(await resolve([row])).toEqual({ kind: "resolved", addressee: { agentId: ids[0], displayName: "Shared" } });
  });

  it.each([["Alpha", "Beta"], ["Zulu", "Able"]])("retains all three UUIDs with independent names %s / %s", async (first, third) => {
    const a = card(0, "metadata", first);
    const b = card(1, "name", "unused");
    const c = card(2, "title", third);
    await expectAmbiguous([c, b, a], [
      { agentId: ids[0]!, name: first },
      { agentId: ids[1]!, name: "Shared" },
      { agentId: ids[2]!, name: third },
    ]);
  });
});
