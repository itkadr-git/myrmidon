import { describe, expect, it, vi } from "vitest";

const nativeLoad = vi.hoisted(() => vi.fn());
vi.mock("./embedded-postgres-native.js", () => {
  nativeLoad();
  return {
    ensureLinuxSharedLibraryAliases: vi.fn(async () => ["alias"]),
    prepareEmbeddedPostgresNativeRuntime: vi.fn(async () => undefined),
  };
});

describe("database barrel native setup", () => {
  it("loads native setup only when a public native helper is called", async () => {
    const db = await import("./index.js");
    expect(nativeLoad).not.toHaveBeenCalled();
    await expect(db.ensureLinuxSharedLibraryAliases("/unused")).resolves.toEqual(["alias"]);
    expect(nativeLoad).toHaveBeenCalledTimes(1);
    await expect(db.prepareEmbeddedPostgresNativeRuntime()).resolves.toBeUndefined();
    expect(nativeLoad).toHaveBeenCalledTimes(1);
  }, 30_000);
});
