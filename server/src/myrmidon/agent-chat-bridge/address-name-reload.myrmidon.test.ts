import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const endpointAgentId = "22222222-2222-4222-8222-222222222222";
const companyId = "33333333-3333-4333-8333-333333333333";
const alias = "steadyalias";

const transitions = Object.freeze([
  Object.freeze({ name: "AlphaOne", absent: "BetaTwo" }),
  Object.freeze({ name: "BetaTwo", absent: "AlphaOne" }),
  Object.freeze({ name: "AlphaOne", absent: "BetaTwo" }),
]);
const snapshots = Object.freeze(transitions.map(({ name }) => Object.freeze([
  Object.freeze({
    id: agentId, name, title: null, status: "idle",
    metadata: Object.freeze({ telegramAliases: Object.freeze([alias]) }),
    adapterConfig: Object.freeze({}),
  }),
])));

describe("bridge address catalog name reload", () => {
  it("resolves the current name and stable ID and alias across renames without writes", async () => {
    let state = 0;
    let reads = 0;
    const writes: string[] = [];
    const chain = {
      select() { return chain; },
      from() { return chain; },
      where() { return chain; },
      orderBy() { reads += 1; return Promise.resolve(snapshots[state]); },
      insert() { writes.push("insert"); throw new Error("unexpected insert"); },
      update() { writes.push("update"); throw new Error("unexpected update"); },
      delete() { writes.push("delete"); throw new Error("unexpected delete"); },
    };
    const db = chain as unknown as Db;
    const address = (text: string) => resolveBridgeAddressee(db, { companyId, text, endpointAgentId });

    for (const [index, transition] of transitions.entries()) {
      state = index;
      const resolved = { kind: "resolved", addressee: { agentId, displayName: transition.name } };
      expect(await address(`agent://${agentId}`)).toEqual(resolved);
      expect(await address(`@${transition.name}`)).toEqual(resolved);
      expect(await address(`@${transition.absent}`)).toEqual({ kind: "none" });
      expect(await address(`@${alias}`)).toEqual(resolved);
    }
    expect(reads).toBe(12);
    expect(writes).toEqual([]);
  });
});
