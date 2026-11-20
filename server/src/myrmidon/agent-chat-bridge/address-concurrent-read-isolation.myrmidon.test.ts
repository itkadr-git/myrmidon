import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveBridgeAddressee } from "./addressing.js";

const COMPANY = "10000000-0000-4000-8000-000000000001";
const ENDPOINT = "10000000-0000-4000-8000-000000000002";
const IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
] as const;
const snapshots = IDS.map((id, index) => Object.freeze([
  Object.freeze({
    id,
    name: `Agent ${index + 1}`,
    title: null,
    status: "active",
    metadata: Object.freeze({ telegramAliases: Object.freeze(["shared"]) }),
    adapterConfig: null,
  }),
]));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("concurrent company directory reads", () => {
  it.each([
    { label: "second before first", order: [1, 0] },
    { label: "first before second", order: [0, 1] },
  ])("keeps each snapshot isolated: $label", async ({ order }) => {
    const reads = [deferred<(typeof snapshots)[number]>(), deferred<(typeof snapshots)[number]>(), deferred<(typeof snapshots)[number]>()];
    const orderBy = vi.fn(() => {
      const read = reads[orderBy.mock.calls.length - 1];
      if (!read) throw new Error("unexpected directory read");
      return read.promise;
    });
    const write = vi.fn(() => { throw new Error("unexpected write"); });
    const db = {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ orderBy }) }) })),
      insert: write,
      update: write,
      delete: write,
    } as unknown as Db;
    const input = { companyId: COMPANY, text: "@shared hello", endpointAgentId: ENDPOINT };
    const expected = IDS.map((agentId, index) => ({
      kind: "resolved",
      addressee: { agentId, displayName: `Agent ${index + 1}` },
    }));

    const first = resolveBridgeAddressee(db, input);
    const second = resolveBridgeAddressee(db, input);
    expect(orderBy).toHaveBeenCalledTimes(2);
    const promises = [first, second];
    for (const index of order) {
      reads[index]!.resolve(snapshots[index]!);
      expect(await promises[index]).toEqual(expected[index]);
    }
    const third = resolveBridgeAddressee(db, input);
    expect(orderBy).toHaveBeenCalledTimes(3);
    reads[2]!.resolve(snapshots[2]!);
    expect(await third).toEqual(expected[2]);
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(write).not.toHaveBeenCalled();
    for (const snapshot of snapshots) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot[0])).toBe(true);
      expect(snapshot[0]!.metadata.telegramAliases).toEqual(["shared"]);
    }
  });
});
