import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const A = { id: "11111111-1111-4111-8111-111111111111", name: "Alpha", alias: "alpha-explicit" };
const B = { id: "22222222-2222-4222-8222-222222222222", name: "Beta", alias: "beta-explicit" };

function row(agent: typeof A, title: string | null) {
  return Object.freeze({
    id: agent.id, name: agent.name, title, status: "active",
    metadata: Object.freeze({ telegramAliases: Object.freeze([agent.alias]) }),
    adapterConfig: Object.freeze({}),
  });
}

const snapshots = Object.freeze([
  Object.freeze([row(A, "HandleTitle"), row(B, null)]),
  Object.freeze([row(A, "HandleTitle"), row(B, "HandleTitle")]),
  Object.freeze([row(A, null), row(B, "HandleTitle")]),
  Object.freeze([row(A, null), row(B, null)]),
  Object.freeze([row(A, "HandleTitle"), row(B, null)]),
]);

const expected = [
  { kind: "resolved", addressee: { agentId: A.id, displayName: A.name } },
  { kind: "ambiguous", handle: "handletitle", candidates: [
    { agentId: A.id, name: A.name }, { agentId: B.id, name: B.name },
  ] },
  { kind: "resolved", addressee: { agentId: B.id, displayName: B.name } },
  { kind: "none" },
  { kind: "resolved", addressee: { agentId: A.id, displayName: A.name } },
];

describe("bridge title catalog reload", () => {
  it("rebuilds title candidates after each update and restores a removed title", async () => {
    let snapshot = 0;
    const writes = vi.fn(() => { throw new Error("resolver must not write"); });
    const orderBy = vi.fn(async () => snapshots[snapshot]);
    const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy,
      insert: writes, update: writes, delete: writes, execute: writes };
    const db = chain as unknown as Db;

    for (snapshot = 0; snapshot < snapshots.length; snapshot++) {
      expect(await resolveBridgeAddressee(db, {
        companyId: "33333333-3333-4333-8333-333333333333",
        endpointAgentId: B.id,
        text: "@HandleTitle",
      }), `snapshot ${snapshot}`).toEqual(expected[snapshot]);
    }
    expect(orderBy).toHaveBeenCalledTimes(snapshots.length);
    expect(writes).not.toHaveBeenCalled();
  });
});
