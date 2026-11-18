import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const firstId = "20000000-0000-4000-8000-000000000001";
const secondId = "20000000-0000-4000-8000-000000000002";
const outsiderId = "20000000-0000-4000-8000-000000000003";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("bridge address result ownership", () => {
  it("isolates repeated and interleaved results from caller mutations", async () => {
    const rows = deepFreeze([
      { id: firstId, name: "Alpha", title: null, status: "active", metadata: { telegramAliases: ["shared", "unique"] }, adapterConfig: null },
      { id: secondId, name: "Beta", title: null, status: "active", metadata: { telegramAliases: ["shared"] }, adapterConfig: null },
    ]);
    const rowsBefore = JSON.stringify(rows);
    const input = deepFreeze({ companyId, endpointAgentId: firstId, text: "@shared" });
    const inputBefore = JSON.stringify(input);
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
    const db = chain as unknown as Db;
    const resolve = (text: string) => resolveBridgeAddressee(db, { ...input, text });
    const ambiguous = {
      kind: "ambiguous",
      handle: "shared",
      candidates: [{ agentId: firstId, name: "Alpha" }, { agentId: secondId, name: "Beta" }],
    };
    const resolved = { kind: "resolved", addressee: { agentId: firstId, displayName: "Alpha" } };

    const first = await resolveBridgeAddressee(db, input);
    expect(first).toEqual(ambiguous);
    if (first.kind !== "ambiguous") throw new Error("expected ambiguous");
    const previousCandidate = first.candidates[0];
    if (!previousCandidate) throw new Error("expected first candidate");
    first.handle = "corrupted";
    previousCandidate.agentId = outsiderId;
    previousCandidate.name = "Corrupted";
    first.candidates.pop();
    first.candidates.push({ agentId: outsiderId, name: "Outsider" });
    const second = await resolveBridgeAddressee(db, input);
    expect(second).toEqual(ambiguous);
    if (second.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(second).not.toBe(first);
    expect(second.candidates).not.toBe(first.candidates);
    expect(second.candidates[0]).not.toBe(previousCandidate);

    const unique = await resolve("@unique");
    expect(unique).toEqual(resolved);
    if (unique.kind !== "resolved") throw new Error("expected resolved");
    unique.addressee.agentId = outsiderId;
    unique.addressee.displayName = "Corrupted";
    const uniqueAgain = await resolve("@unique");
    expect(uniqueAgain).toEqual(resolved);
    if (uniqueAgain.kind !== "resolved") throw new Error("expected resolved");
    expect(uniqueAgain).not.toBe(unique);
    expect(uniqueAgain.addressee).not.toBe(unique.addressee);

    for (let i = 0; i < 2; i++) {
      expect(await resolve("@shared")).toEqual(ambiguous);
      expect(await resolve("@unique")).toEqual(resolved);
      expect(await resolve("@missing")).toEqual({ kind: "none" });
      expect(await resolve("@shared")).toEqual(ambiguous);
    }
    expect(JSON.stringify(rows)).toBe(rowsBefore);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });
});
