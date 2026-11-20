import { describe, expect, it, vi } from "vitest";

const clientLoad = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => {
  clientLoad();
  return {
    applyPendingMigrations: vi.fn(),
    closeRegisteredClients: vi.fn(),
    ensurePostgresDatabase: vi.fn(),
  };
});

describe("embedded PostgreSQL test helper imports", () => {
  it("does not load the database client until a test database is started", async () => {
    const helper = await import("./test-embedded-postgres.js");
    expect(helper.EMBEDDED_POSTGRES_TEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(clientLoad).not.toHaveBeenCalled();
  });
});
