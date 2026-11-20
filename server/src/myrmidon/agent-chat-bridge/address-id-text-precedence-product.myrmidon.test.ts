import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const alpha = "11111111-1111-4111-8111-111111111111";
const beta = "22222222-2222-4222-8222-222222222222";
const gamma = "33333333-3333-4333-8333-333333333333";
const hidden = "44444444-4444-4444-8444-444444444444";
const unknown = "55555555-5555-4555-8555-555555555555";
const rows = [
  { id: alpha, name: "Alpha", title: null, status: "active", metadata: { telegramAliases: ["unique", "shared"] }, adapterConfig: null },
  { id: beta, name: "Beta", title: null, status: "active", metadata: { telegramAliases: ["shared"] }, adapterConfig: null },
  { id: gamma, name: "Gamma", title: null, status: "active", metadata: { telegramAliases: ["other"] }, adapterConfig: null },
  { id: hidden, name: "Hidden", title: null, status: "paused", metadata: { telegramAliases: ["hidden"] }, adapterConfig: null },
];

function fixture() {
  const original = structuredClone(rows);
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
  return {
    db: chain as unknown as Db,
    verify(expectedReads: number) {
      expect(reads).toBe(expectedReads);
      expect(rows).toEqual(original);
    },
  };
}

const backgrounds = [
  { name: "unique", text: "@missing @unique @shared", expected: { kind: "resolved", addressee: { agentId: alpha, displayName: "Alpha" } } },
  { name: "ambiguous", text: "@missing @shared @unique", expected: { kind: "ambiguous", handle: "shared", candidates: [{ agentId: alpha, name: "Alpha" }, { agentId: beta, name: "Beta" }] } },
  { name: "unknown", text: "@missing @absent", expected: { kind: "none" } },
];
const idCases = [
  { name: "live", text: `agent://${gamma}`, expected: { kind: "resolved", addressee: { agentId: gamma, displayName: "Gamma" } } },
  { name: "unknown", text: `agent://${unknown}`, expected: { kind: "invalid_id" } },
  { name: "hidden", text: `agent://${hidden}`, expected: { kind: "invalid_id" } },
  { name: "duplicate", text: `agent://${gamma} agent://${gamma}`, expected: { kind: "invalid_id" } },
  { name: "different", text: `agent://${alpha} agent://${gamma}`, expected: { kind: "invalid_id" } },
];
const matrix = backgrounds.flatMap((background) => idCases.flatMap((idCase) =>
  ["before", "after"].map((position) => ({ background, idCase, position })),
));

const resolve = (db: Db, text: string) => resolveBridgeAddressee(db, { companyId, endpointAgentId: beta, text });

describe("explicit ID precedence over textual token sequences", () => {
  it.each(matrix)("$background.name / $idCase.name / URI $position", async ({ background, idCase, position }) => {
    const { db, verify } = fixture();
    const text = position === "before" ? ` ${idCase.text} ${background.text} ` : ` ${background.text} ${idCase.text} `;
    // Text-only control establishes the exact independent oracle, including the candidate set.
    expect(await resolve(db, background.text)).toEqual(background.expected);
    expect(await resolve(db, text)).toEqual(idCase.expected);
    expect(await resolve(db, background.text)).toEqual(background.expected);
    verify(3);
  });

  it("does not reuse a previous result across sequential ID and text resolutions", async () => {
    const { db, verify } = fixture();
    expect(await resolve(db, `@shared agent://${gamma}`)).toEqual({ kind: "resolved", addressee: { agentId: gamma, displayName: "Gamma" } });
    expect(await resolve(db, `@unique agent://${hidden}`)).toEqual({ kind: "invalid_id" });
    expect(await resolve(db, "@shared @unique")).toEqual({ kind: "ambiguous", handle: "shared", candidates: [{ agentId: alpha, name: "Alpha" }, { agentId: beta, name: "Beta" }] });
    expect(await resolve(db, `@unique agent://${beta}`)).toEqual({ kind: "resolved", addressee: { agentId: beta, displayName: "Beta" } });
    verify(4);
  });
});
