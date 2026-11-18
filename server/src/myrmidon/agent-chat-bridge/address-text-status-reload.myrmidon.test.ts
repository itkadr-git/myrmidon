import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const endpointId = "33333333-3333-4333-8333-333333333333";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

const first = freezeDeep({ id: firstId, name: "Alpha", title: null, status: "idle", metadata: { telegramAliases: ["dispatch"] }, adapterConfig: {} });
const second = freezeDeep({ id: secondId, name: "Bravo", title: null, metadata: { telegramAliases: ["dispatch"] }, adapterConfig: {} });
const transitions = [
  { status: "paused", kind: "resolved" },
  { status: "idle", kind: "ambiguous" },
  { status: "terminated", kind: "resolved" },
  { status: "running", kind: "ambiguous" },
] as const;

describe("textual addressing reloads status changes", () => {
  it("recomputes duplicate alias ambiguity on the same database handle", async () => {
    let rows = freezeDeep([first, { ...second, status: "paused" }]);
    const write = vi.fn(() => { throw new Error("unexpected database write"); });
    const chain = {
      select() { return chain; },
      from() { return chain; },
      where() { return chain; },
      orderBy() { return Promise.resolve(rows); },
      insert: write, update: write, delete: write,
    };
    const db = chain as unknown as Db;

    for (const transition of transitions) {
      rows = freezeDeep([first, { ...second, status: transition.status }]);
      const result = await resolveBridgeAddressee(db, {
        companyId: "company-a", endpointAgentId: endpointId, text: "@dispatch",
      });
      if (transition.kind === "resolved") {
        expect(result, transition.status).toEqual({ kind: "resolved", addressee: { agentId: firstId, displayName: "Alpha" } });
      } else {
        expect(result.kind, transition.status).toBe("ambiguous");
        if (result.kind !== "ambiguous") throw new Error(`expected ambiguity for ${transition.status}`);
        expect({ ...result, candidates: [...result.candidates].sort((a, b) => a.agentId.localeCompare(b.agentId)) }).toEqual({
          kind: "ambiguous", handle: "dispatch", candidates: [
            { agentId: firstId, name: "Alpha" }, { agentId: secondId, name: "Bravo" },
          ],
        });
      }
    }
    expect(write).not.toHaveBeenCalled();
  });
});
