import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const company = "company-a";
const foreignCompany = "company-b";
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];
const foreignId = "44444444-4444-4444-8444-444444444444";
const unknownId = "55555555-5555-4555-8555-555555555555";

type Row = {
  id: string;
  name: string;
  title: string | null;
  status: string;
  metadata: { telegramAliases: string[] };
  adapterConfig: null;
};

function dbFor(rowsByCompany: Record<string, Row[]>): Db {
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const companyId = new PgDialect().sqlToQuery(condition).params[0];
      return { orderBy: async () => rowsByCompany[String(companyId)] ?? [] };
    },
  };
  return chain as unknown as Db;
}

function permutations<T>(values: T[]): T[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]),
  );
}

function cards(renamed: boolean): Row[] {
  return ids.map((id, index) => ({
    id,
    name: renamed ? (index === 2 ? unknownId : "Collision") : ["Alpha", "Beta", "Gamma"][index]!,
    title: renamed ? "SharedTitle" : ["First", "Second", "Third"][index]!,
    status: "active",
    metadata: { telegramAliases: renamed ? ["shared", foreignId] : [`alias${index}`] },
    adapterConfig: null,
  }));
}

describe("explicit bridge agent IDs under candidate permutations", () => {
  it("keeps the same ID across all candidate orders and renamed, colliding cards", async () => {
    for (const renamed of [false, true]) {
      for (const rows of permutations(cards(renamed))) {
        for (const target of rows) {
          const result = await resolveBridgeAddressee(dbFor({ [company]: rows }), {
            companyId: company,
            endpointAgentId: ids[0]!,
            text: `@shared agent://${target.id.toUpperCase()} hello`,
          });
          expect(result).toEqual({
            kind: "resolved",
            addressee: { agentId: target.id, displayName: target.name },
          });
        }
      }
    }
  });

  it("rejects foreign and unknown IDs even when their UUIDs are local handles", async () => {
    const foreign: Row = {
      ...cards(false)[0]!, id: foreignId, name: "Foreign",
    };
    for (const rows of permutations(cards(true))) {
      const db = dbFor({ [company]: rows, [foreignCompany]: [foreign] });
      for (const id of [foreignId, unknownId]) {
        expect(await resolveBridgeAddressee(db, {
          companyId: company,
          endpointAgentId: ids[0]!,
          text: `@${id} agent://${id} hello`,
        })).toEqual({ kind: "invalid_id" });
      }
    }
  });
});
