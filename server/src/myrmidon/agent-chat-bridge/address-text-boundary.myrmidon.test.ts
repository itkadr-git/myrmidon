import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { findMention, resolveBridgeAddressee } from "./addressing.js";

const latin = { id: "11111111-1111-4111-8111-111111111111", name: "Mira", title: null, status: "active", metadata: null, adapterConfig: null };
const cyrillic = { ...latin, id: "22222222-2222-4222-8222-222222222222", name: "Мira" };
const upper = { ...latin, id: "33333333-3333-4333-8333-333333333333", name: "MIRA" };

function dbFor(rows: typeof latin[]): Db {
  const query = { select: () => query, from: () => query, where: () => query, orderBy: async () => rows };
  return query as unknown as Db;
}

function resolve(text: string, rows = [latin, cyrillic]) {
  return resolveBridgeAddressee(dbFor(rows), { companyId: "synthetic-company", endpointAgentId: latin.id, text });
}

describe("address text boundaries", () => {
  it.each([
    ["\t@МИРА!", { handle: "мира", leading: true }],
    ["say\n@Mira: now", { handle: "mira", leading: false }],
    ["(@Mira)", null],
    ["name@Mira.example", null],
    ["@Mira/other", { handle: "mira/other", leading: true }],
    ["@Mira;next", { handle: "mira", leading: true }],
  ])("findMention(%j) preserves its separator contract", (text, expected) => {
    expect(findMention(text)).toEqual(expected);
  });

  it.each([
    ["@MIRA!", latin],
    ["please @мira, respond", cyrillic],
    ["@Мira?", cyrillic],
  ])("resolves %j without mixing scripts", async (text, agent) => {
    expect(await resolve(text)).toEqual({ kind: "resolved", addressee: { agentId: agent.id, displayName: agent.name } });
  });

  it.each(["@Mir", "@Mira_extra", "@Mira-extended", "@Mirа", "@Mi\u0301ra"])("does not resolve partial or differently normalized %j", async (text) => {
    expect(await resolve(text, [latin])).toEqual({ kind: "none" });
  });

  it.each(["mail user@Mira.example", "const x = user@Mira.example"])("does not route an email or code fragment: %j", async (text) => {
    expect(await resolve(text, [latin])).toEqual({ kind: "none" });
  });

  it("reports case-folded duplicate names independently of candidate order", async () => {
    for (const rows of [[latin, upper], [upper, latin]]) {
      const result = await resolve("@mIrA", rows);
      expect(result.kind).toBe("ambiguous");
      if (result.kind !== "ambiguous") throw new Error("expected ambiguity");
      expect(result.handle).toBe("mira");
      expect(result.candidates).toEqual(expect.arrayContaining([
        { agentId: latin.id, name: latin.name }, { agentId: upper.id, name: upper.name },
      ]));
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("keeps valid explicit IDs authoritative in mixed text", async () => {
    expect(await resolve(`agent://${cyrillic.id} @Mira`)).toEqual({
      kind: "resolved", addressee: { agentId: cyrillic.id, displayName: cyrillic.name },
    });
  });
});
