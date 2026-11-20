import { describe, expect, it, vi } from "vitest";

const driverLoad = vi.hoisted(() => vi.fn());
vi.mock("drizzle-orm/postgres-js", () => {
  driverLoad();
  return { drizzle: vi.fn() };
});

describe("application database imports", () => {
  it("does not load the database client driver just to import the application", async () => {
    await import("../app.js");
    expect(driverLoad).not.toHaveBeenCalled();
  }, 60_000);
});
