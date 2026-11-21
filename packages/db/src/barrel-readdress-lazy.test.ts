import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => vi.fn());
vi.mock("./readdress-report.js", () => {
  loaded();
  return { resolveAddresslessCard: vi.fn() };
});

describe("database root readdress graph", () => {
  it("does not load the readdress report until the apply operation runs", async () => {
    const db = await import("./index.js");
    expect(loaded).not.toHaveBeenCalled();
    const database = { execute: vi.fn().mockResolvedValue([]) };
    await expect(db.applyReaddress(database as never)).resolves.toMatchObject({ totalCandidates: 0 });
    expect(loaded).toHaveBeenCalledTimes(1);
  }, 30_000);
});
