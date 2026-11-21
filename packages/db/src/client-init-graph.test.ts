import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./migration-init.js", () => {
  loaded();
  return { listMigrationChain: vi.fn(async () => [{ idx: 1, tag: "migration", hash: "hash", when: 1 }]) };
});

describe("database client initialization graph", () => {
  it("loads migration initialization only when a migration operation is called", async () => {
    const client = await import("./client.js");
    expect(loaded).not.toHaveBeenCalled();
    await expect(client.listMigrationChain()).resolves.toEqual([{ idx: 1, tag: "migration", hash: "hash", when: 1 }]);
    expect(loaded).toHaveBeenCalledTimes(1);
  }, 30_000);
});
