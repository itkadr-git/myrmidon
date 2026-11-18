import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

interface AgentRow {
  id: string;
  name: string;
  title: string;
  status: string;
  metadata: { telegramAliases: string[] };
  adapterConfig: null;
}

const companyId = "10000000-0000-4000-8000-000000000001";
const alpha: AgentRow = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Alpha", title: "Coordinator", status: "active",
  metadata: { telegramAliases: ["dispatch", "triage"] }, adapterConfig: null,
};
const bravo: AgentRow = {
  id: "20000000-0000-4000-8000-000000000002",
  name: "Bravo", title: "Specialist", status: "active",
  metadata: { telegramAliases: ["triage"] }, adapterConfig: null,
};
const relevant: AgentRow = {
  id: "20000000-0000-4000-8000-000000000003",
  name: "Charlie", title: "Operator", status: "active",
  metadata: { telegramAliases: ["dispatch"] }, adapterConfig: null,
};

function fakeDb(rows: AgentRow[]): Db {
  const chain = {
    select() { return chain; },
    from() { return chain; },
    where(condition: SQL) {
      const rendered = new PgDialect().sqlToQuery(condition);
      expect(rendered.sql).toMatch(/"company_id" = \$1/);
      expect(rendered.params).toEqual([companyId]);
      return { orderBy: async () => [...rows] };
    },
  };
  return chain as unknown as Db;
}

const dispatch = {
  kind: "resolved",
  addressee: { agentId: "20000000-0000-4000-8000-000000000001", displayName: "Alpha" },
};
const triage = {
  kind: "ambiguous", handle: "triage",
  candidates: [
    { agentId: "20000000-0000-4000-8000-000000000001", name: "Alpha" },
    { agentId: "20000000-0000-4000-8000-000000000002", name: "Bravo" },
  ],
};
const ambiguousDispatch = {
  kind: "ambiguous", handle: "dispatch",
  candidates: [
    { agentId: "20000000-0000-4000-8000-000000000001", name: "Alpha" },
    { agentId: "20000000-0000-4000-8000-000000000003", name: "Charlie" },
  ],
};

describe("address catalog noninterference", () => {
  it.each([1, 5, 20])("preserves exact results across %i unrelated additions and removal", async (count) => {
    const rows = [alpha, bravo];
    const db = fakeDb(rows);
    const resolve = (text: string) => resolveBridgeAddressee(db, {
      companyId, endpointAgentId: alpha.id, text,
    });
    const assertOriginal = async () => {
      expect(await resolve("@dispatch")).toEqual(dispatch);
      expect(await resolve("@triage")).toEqual(triage);
      expect(await resolve("@unknown")).toEqual({ kind: "none" });
    };
    await assertOriginal();
    for (let i = 0; i < count; i++) {
      const suffix = String(i).padStart(2, "0");
      rows.push({
        id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        name: `Zulu${suffix}`, title: `Role${suffix}`, status: "active",
        metadata: { telegramAliases: [`extra${suffix}`] }, adapterConfig: null,
      });
    }
    await assertOriginal();
    rows.splice(2);
    await assertOriginal();
    rows.push(relevant);
    expect(await resolve("@dispatch")).toEqual(ambiguousDispatch);
    expect(await resolve("@triage")).toEqual(triage);
    expect(await resolve("@unknown")).toEqual({ kind: "none" });
  });
});
