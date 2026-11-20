import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const COMPANY = "company-a";
const OTHER_COMPANY = "company-b";
const A = "abcdef01-2345-4abc-8def-123456789abc";
const B = "12345678-abcd-4abc-8def-123456789abc";
const OTHER = "fedcba98-7654-4abc-8def-123456789abc";
const UNKNOWN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const rows: Record<string, Array<{
  id: string;
  name: string;
  title: string | null;
  status: string;
  metadata: { telegramAliases: string[] } | null;
  adapterConfig: null;
}>> = {
  [COMPANY]: [
    { id: A, name: "Agent A", title: null, status: "active", metadata: null, adapterConfig: null },
    { id: B, name: "Agent B", title: null, status: "active", metadata: { telegramAliases: ["writer"] }, adapterConfig: null },
  ],
  [OTHER_COMPANY]: [
    { id: OTHER, name: "Other Agent", title: null, status: "active", metadata: null, adapterConfig: null },
  ],
};

function fakeDb() {
  const conditions: SQL[] = [];
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      conditions.push(condition);
      const companyId = new PgDialect().sqlToQuery(condition).params[0];
      return { orderBy: async () => typeof companyId === "string" ? rows[companyId] ?? [] : [] };
    },
  };
  return { db: chain as unknown as Db, conditions };
}

describe("explicit agent ID addressing contract", () => {
  async function resolve(text: string) {
    const { db, conditions } = fakeDb();
    const input = { companyId: COMPANY, endpointAgentId: B, text };
    const original = structuredClone(input);
    const originalRows = structuredClone(rows);
    const result = await resolveBridgeAddressee(db, input);
    expect(input).toEqual(original);
    expect(rows).toEqual(originalRows);
    expect(conditions).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(conditions[0]!);
    expect(query.sql).toMatch(/"company_id" = \$1/);
    expect(query.params).toEqual([COMPANY]);
    return result;
  }

  it.each([A, A.toUpperCase()])("prefers explicit ID %s to another agent's alias", async (id) => {
    expect(await resolve(`@writer agent://${id} hello`)).toEqual({
      kind: "resolved",
      addressee: { agentId: A, displayName: "Agent A" },
    });
  });

  it("resolves the alias without an explicit ID", async () => {
    expect(await resolve("@writer hello")).toEqual({
      kind: "resolved",
      addressee: { agentId: B, displayName: "Agent B" },
    });
  });

  it.each([
    ["unknown ID", `agent://${UNKNOWN}`],
    ["another company's ID", `agent://${OTHER}`],
    ["malformed ID", "agent://not-a-uuid"],
    ["two explicit IDs", `agent://${A} agent://${B}`],
  ])("rejects %s without falling back to the alias", async (_label, explicit) => {
    expect(await resolve(`@writer ${explicit}`)).toEqual({ kind: "invalid_id" });
  });
});
