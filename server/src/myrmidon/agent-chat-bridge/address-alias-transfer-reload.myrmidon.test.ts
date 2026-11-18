import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const A = "abcdef01-2345-4abc-8def-123456789abc";
const B = "12345678-abcd-4abc-8def-123456789abc";

type Card = {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly status: string;
  readonly metadata: { readonly telegramAliases: readonly string[] };
  readonly adapterConfig: Readonly<Record<string, unknown>>;
};

function card(id: string, name: string, title: string, ownsAlias: boolean): Card {
  return Object.freeze({
    id, name, title, status: "active",
    metadata: Object.freeze({ telegramAliases: Object.freeze(ownsAlias ? ["dispatch"] : []) }),
    adapterConfig: Object.freeze({}),
  });
}

function snapshot(owner: "A" | "B" | "none"): readonly Card[] {
  return Object.freeze([
    card(A, "Alpha Writer", "Editorial Lead", owner === "A"),
    card(B, "Beta Writer", "Copy Editor", owner === "B"),
  ]);
}

const snapshots = Object.freeze([snapshot("A"), snapshot("B"), snapshot("none"), snapshot("A")]);
const transitions = [
  { label: "alias on A", expected: { kind: "resolved", addressee: { agentId: A, displayName: "Alpha Writer" } } },
  { label: "alias moved to B", expected: { kind: "resolved", addressee: { agentId: B, displayName: "Beta Writer" } } },
  { label: "alias removed", expected: { kind: "none" } },
  { label: "alias returned to A", expected: { kind: "resolved", addressee: { agentId: A, displayName: "Alpha Writer" } } },
] as const;

describe("bridge alias transfer reload", () => {
  it("routes each lookup from the latest catalog snapshot without writes or endpoint fallback", async () => {
    let reads = 0;
    const writes = { insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() };
    const chain = {
      ...writes,
      select: () => chain,
      from: () => chain,
      where: () => chain,
      orderBy: async () => {
        const rows = snapshots[reads++];
        if (!rows) throw new Error("unexpected catalog read");
        return rows;
      },
    };
    const db = chain as unknown as Db;

    for (const [index, transition] of transitions.entries()) {
      const result = await resolveBridgeAddressee(db, {
        companyId: "company-a",
        endpointAgentId: index === 2 ? A : B,
        text: "@dispatch",
      });
      expect(result, transition.label).toEqual(transition.expected);
    }

    expect(reads).toBe(4);
    for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled();
  });
});
