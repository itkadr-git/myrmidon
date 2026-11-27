import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./migration-init.js", () => {
  loaded();
  return { inspectMigrations: vi.fn(async () => ({ status: "upToDate", tableCount: 1 })) };
});

describe("database client initialization graph", () => {
  it("loads migration initialization only when a migration operation is called", async () => {
    const client = await import("./client.js");
    expect(loaded).not.toHaveBeenCalled();
    await expect(client.inspectMigrations("postgres://localhost/unused")).resolves.toEqual({ status: "upToDate", tableCount: 1 });
    expect(loaded).toHaveBeenCalledTimes(1);
  }, 30_000);
});
