import { describe, expect, it, vi } from "vitest";

const driverLoaded = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => {
  driverLoaded();
  return { default: vi.fn() };
});

describe("embedded database test helper imports", () => {
  it("does not load the postgres driver until a database is created", async () => {
    await import("./test-embedded-postgres.js");
    expect(driverLoaded).not.toHaveBeenCalled();
  });
});
