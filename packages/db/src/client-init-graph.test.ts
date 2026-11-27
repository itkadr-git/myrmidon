import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./migration-init.js", () => {
  loaded();
  return { applyPendingMigrations: vi.fn(async () => {}) };
});
vi.mock("./postgres-utility.js", async (importOriginal) => {
  const utility = await importOriginal<typeof import("./postgres-utility.js")>();
  return {
    ...utility,
    createUtilitySql: async () => Object.assign(
      async (parts: TemplateStringsArray) => parts[0].includes("information_schema.tables") ? [{ count: 0 }] : [],
      { end: async () => {} },
    ),
  };
});

describe("database client initialization graph", () => {
  it("loads migration initialization only when a write operation is called", async () => {
    const client = await import("./client.js");
    expect(loaded).not.toHaveBeenCalled();
    const url = "postgres://localhost/unused";
    await expect(client.inspectMigrations(url)).resolves.toMatchObject({
      status: "needsMigrations",
      reason: "no-migration-journal-empty-db",
    });
    expect(loaded).not.toHaveBeenCalled();
    await client.applyPendingMigrations(url);
    expect(loaded).toHaveBeenCalledTimes(1);
  }, 30_000);
});
