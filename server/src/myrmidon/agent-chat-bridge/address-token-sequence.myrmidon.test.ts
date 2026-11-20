import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const A = { id: "agent-a", name: "Alpha", title: "sharedtitle", status: "active", metadata: { telegramAliases: ["uniquea", "shared", "sharedname"] }, adapterConfig: {} };
const B = { id: "agent-b", name: "sharedname", title: "Writer", status: "active", metadata: { telegramAliases: ["uniqueb", "shared", "sharedtitle"] }, adapterConfig: {} };

function fakeDb(rows: object[]): Db {
  const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy: async () => rows };
  return chain as unknown as Db;
}

const db = fakeDb([A, B]);
const resolve = (text: string, endpointAgentId: string, database = db) =>
  resolveBridgeAddressee(database, { companyId: "company-a", endpointAgentId, text });

const resolvedA = { kind: "resolved", addressee: { agentId: A.id, displayName: A.name } };
const resolvedB = { kind: "resolved", addressee: { agentId: B.id, displayName: B.name } };
const cases = [
  { text: "@unknown @missing", expected: { kind: "none" } },
  { text: "@unknown @uniquea @uniqueb", expected: resolvedA },
  { text: "@unknown @uniqueb @uniquea", expected: resolvedB },
  { text: "@uniquea @shared", expected: resolvedA },
  { text: "@uniqueb @shared", expected: resolvedB },
];

describe("bridge mention token sequences", () => {
  for (const endpoint of [A.id, B.id, "other-agent"]) {
    it.each(cases)(`uses the first matching token for $text (endpoint ${endpoint})`, async ({ text, expected }) => {
      expect(await resolve(text, endpoint)).toEqual(expected);
    });

    it.each(["@shared @uniquea", "@unknown @shared @uniqueb"])(
      `does not resolve an earlier ambiguous token in %s (endpoint ${endpoint})`, async (text) => {
        const result = await resolve(text, endpoint);
        expect(result.kind).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error("expected ambiguity");
        expect(result.handle).toBe("shared");
        expect(result.candidates).toHaveLength(2);
        expect(new Set(result.candidates.map((candidate) => `${candidate.agentId}:${candidate.name}`))).toEqual(
          new Set([`${A.id}:${A.name}`, `${B.id}:${B.name}`]),
        );
      },
    );
  }

  it("deduplicates the same ID across name, title and aliases in both JSON fields", async () => {
    const row = { id: "agent-single", name: "Same", title: "Same", status: "active", metadata: { telegramAliases: ["same", "same"] }, adapterConfig: { telegramAliases: ["same", "same"] } };
    expect(await resolve("@same", B.id, fakeDb([row]))).toEqual({
      kind: "resolved", addressee: { agentId: row.id, displayName: row.name },
    });
  });

  it.each(["sharedname", "sharedtitle"])("retains both IDs when an alias collides with another agent's %s", async (handle) => {
    const result = await resolve(`@${handle}`, A.id);
    expect(result.kind).toBe("ambiguous");
    if (result.kind !== "ambiguous") throw new Error("expected ambiguity");
    expect(result.handle).toBe(handle);
    expect(result.candidates).toHaveLength(2);
    expect(new Set(result.candidates.map((candidate) => `${candidate.agentId}:${candidate.name}`))).toEqual(
      new Set([`${A.id}:${A.name}`, `${B.id}:${B.name}`]),
    );
  });
});
