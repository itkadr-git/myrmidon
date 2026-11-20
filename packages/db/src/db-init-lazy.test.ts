import { describe, expect, it, vi } from "vitest";

const nativeLoad = vi.hoisted(() => vi.fn());
vi.mock("./embedded-postgres-native.js", () => {
  nativeLoad();
  return { prepareEmbeddedPostgresNativeRuntime: vi.fn(), ensureLinuxSharedLibraryAliases: vi.fn() };
});

describe("database initialization imports", () => {
  it("does not load native Postgres setup when importing the test helper", async () => {
    await import("./test-embedded-postgres.js");
    expect(nativeLoad).not.toHaveBeenCalled();
  });
});
