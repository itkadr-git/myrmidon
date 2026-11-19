import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
type Field = "alias" | "name" | "title";

function card(id: string, field: Field, handle: string, name: string) {
  return {
    id, name: field === "name" ? handle : name,
    title: field === "title" ? handle : null,
    status: "active", metadata: { telegramAliases: field === "alias" ? [handle] : [] },
    adapterConfig: null,
  };
}

function fakeDb(rows: ReturnType<typeof card>[]) {
  let reads = 0;
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const query = new PgDialect().sqlToQuery(condition);
      expect(query.sql).toMatch(/"company_id" = \$1/);
      expect(query.params).toEqual([companyId]);
      reads += 1;
      return { orderBy: async () => rows };
    },
  };
  return { db: chain as unknown as Db, reads: () => reads };
}

const scripts = [
  { label: "ASCII", cases: ["agent", "AGENT", "AgEnT"] },
  { label: "Cyrillic", cases: ["агент", "АГЕНТ", "АгЕнТ"] },
];

describe("text address case equivariance", () => {
  for (const field of ["alias", "name", "title"] as const) {
    for (const { label, cases } of scripts) {
      it(`resolves all card and mention case combinations for ${label} ${field}`, async () => {
        for (const handle of cases) {
          for (const mention of cases) {
            const row = card(firstId, field, handle, "DisplayOne");
            const database = fakeDb([row]);
            expect(await resolveBridgeAddressee(database.db, { companyId, endpointAgentId: otherId, text: `@${mention}` }))
              .toEqual({ kind: "resolved", addressee: { agentId: firstId, displayName: field === "name" ? handle : "DisplayOne" } });
            expect(database.reads()).toBe(1);
          }
        }
      });

      it(`keeps all case-colliding ${label} ${field} candidates for every endpoint`, async () => {
        for (const handle of cases) {
          for (const mention of cases) {
            for (const endpointAgentId of [firstId, secondId, otherId]) {
              const rows = [card(firstId, field, handle, "First"), card(secondId, field, cases[1]!, "Second")];
              const database = fakeDb(rows);
              const result = await resolveBridgeAddressee(database.db, { companyId, endpointAgentId, text: `@${mention}` });
              expect(result.kind).toBe("ambiguous");
              if (result.kind !== "ambiguous") throw new Error("expected ambiguous result");
              expect(result.handle).toBe(cases[0]);
              expect(result.candidates).toHaveLength(2);
              expect(new Set(result.candidates.map(({ agentId, name }) => `${agentId}:${name}`))).toEqual(new Set([
                `${firstId}:${field === "name" ? handle : "First"}`,
                `${secondId}:${field === "name" ? cases[1] : "Second"}`,
              ]));
              expect(database.reads()).toBe(1);
            }
          }
        }
      });
    }
  }

  it.each(["unknown", "agent", "aгент", "cafe", "cafe\u0301"])("does not transliterate or normalize unmatched @%s", async (mention) => {
    const rows = [card(firstId, "alias", "агент", "First"), card(secondId, "alias", "café", "Second")];
    const database = fakeDb(rows);
    expect(await resolveBridgeAddressee(database.db, { companyId, endpointAgentId: firstId, text: `@${mention}` })).toEqual({ kind: "none" });
    expect(database.reads()).toBe(1);
  });

  it("distinguishes Latin a from Cyrillic а", async () => {
    const database = fakeDb([card(firstId, "alias", "a", "Latin"), card(secondId, "alias", "а", "Cyrillic")]);
    expect(await resolveBridgeAddressee(database.db, { companyId, endpointAgentId: otherId, text: "@A" }))
      .toEqual({ kind: "resolved", addressee: { agentId: firstId, displayName: "Latin" } });
    expect(await resolveBridgeAddressee(database.db, { companyId, endpointAgentId: otherId, text: "@А" }))
      .toEqual({ kind: "resolved", addressee: { agentId: secondId, displayName: "Cyrillic" } });
    expect(database.reads()).toBe(2);
  });
});
