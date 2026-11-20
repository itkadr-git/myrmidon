import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const agentA = "20000000-0000-4000-8000-000000000001";
const agentB = "20000000-0000-4000-8000-000000000002";

type Card = { telegramAliases: string[] } | null;
type Row = {
  id: string;
  name: string;
  title: null;
  status: string;
  metadata: Card;
  adapterConfig: Card;
};

function fakeDb(rows: Row[]): Db {
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

const card = (...telegramAliases: string[]): Card => ({ telegramAliases });
const representations: Array<{ name: string; cards: [Card, Card, Card, Card] }> = [
  { name: "metadata only", cards: [card("triage", "dispatch"), null, card("triage"), null] },
  { name: "adapter only", cards: [null, card("triage", "dispatch"), null, card("triage")] },
  { name: "split", cards: [card("triage"), card("dispatch"), null, card("triage")] },
  { name: "duplicated with case and whitespace", cards: [card(" TRIAGE ", " Dispatch "), card("triage", "DISPATCH"), card(" Triage "), card("TRIAGE")] },
];

describe.each(representations)("alias catalog: $name", ({ cards }) => {
  const rows: Row[] = [
    { id: agentA, name: "Alpha", title: null, status: "active", metadata: cards[0], adapterConfig: cards[1] },
    { id: agentB, name: "Bravo", title: null, status: "active", metadata: cards[2], adapterConfig: cards[3] },
  ];
  const resolve = (text: string) => resolveBridgeAddressee(fakeDb(rows), { companyId, endpointAgentId: agentB, text });

  it("resolves the unique alias to Alpha", async () => {
    expect(await resolve("@dispatch please")).toEqual({
      kind: "resolved", addressee: { agentId: agentA, displayName: "Alpha" },
    });
  });

  it("returns each matching agent once for the shared alias", async () => {
    expect(await resolve("@TRIAGE please")).toEqual({
      kind: "ambiguous", handle: "triage", candidates: [
        { agentId: agentA, name: "Alpha" },
        { agentId: agentB, name: "Bravo" },
      ],
    });
  });

  it("returns none for an unknown alias", async () => {
    expect(await resolve("@unrecognized please")).toEqual({ kind: "none" });
  });
});
