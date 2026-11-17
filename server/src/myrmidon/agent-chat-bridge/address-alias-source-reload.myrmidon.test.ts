import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const endpointAgentId = "22222222-2222-4222-8222-222222222222";
const resolved = { kind: "resolved", addressee: { agentId, displayName: "Orion" } };

function snapshot(metadataAliases: string[], adapterAliases: string[]) {
  return Object.freeze([Object.freeze({
    id: agentId,
    name: "Orion",
    title: "Navigator",
    status: "active",
    metadata: Object.freeze({ telegramAliases: Object.freeze(metadataAliases) }),
    adapterConfig: Object.freeze({ telegramAliases: Object.freeze(adapterAliases) }),
  })]);
}

describe("bridge alias source reload", () => {
  it("reloads both sources without retaining removed aliases or duplicate IDs", async () => {
    const states = [
      { rows: snapshot(["dispatch"], ["dispatch"]), expected: resolved },
      { rows: snapshot([], ["dispatch"]), expected: resolved },
      { rows: snapshot([], []), expected: { kind: "none" } },
      { rows: snapshot(["dispatch"], []), expected: resolved },
    ];
    const originals = structuredClone(states.map(({ rows }) => rows));
    let index = 0;
    const orderBy = vi.fn(async () => states[index]!.rows);
    const write = vi.fn(() => { throw new Error("unexpected write"); });
    const chain = { select: () => chain, from: () => chain, where: () => chain, orderBy, insert: write, update: write, delete: write };
    const db = chain as unknown as Db;
    const input = Object.freeze({ companyId: "33333333-3333-4333-8333-333333333333", endpointAgentId, text: "@dispatch" });

    for (index = 0; index < states.length; index += 1) {
      expect(await resolveBridgeAddressee(db, input), `snapshot ${index}`).toEqual(states[index]!.expected);
    }
    expect(orderBy).toHaveBeenCalledTimes(states.length);
    expect(write).not.toHaveBeenCalled();
    expect(states.map(({ rows }) => rows)).toEqual(originals);
    expect(input).toEqual({ companyId: "33333333-3333-4333-8333-333333333333", endpointAgentId, text: "@dispatch" });
  });
});
