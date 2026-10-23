import { describe, expect, it, vi } from "vitest";
import { failoverSite } from "./site-failover-orchestrator.js";

describe("failoverSite", () => {
  it("moves unpinned bots and sends pinned bots to manual recovery", async () => {
    const moveBot = vi.fn(async () => undefined);
    const markUnavailable = vi.fn(async () => undefined);
    const result = await failoverSite("primary", {
      listBots: async () => [
        { botKey: "worker", companyId: "c1", pinned: false },
        { botKey: "pinned", companyId: "c1", pinned: true },
      ],
      selectReserve: async () => "reserve",
      moveBot,
      markUnavailable,
    });
    expect(moveBot).toHaveBeenCalledExactlyOnceWith({ companyId: "c1", botKey: "worker", dstSite: "reserve" });
    expect(markUnavailable).toHaveBeenCalledExactlyOnceWith({ companyId: "c1", botKey: "pinned", siteName: "primary" });
    expect(result).toEqual({ moved: ["worker"], unavailable: ["pinned"], skipped: [] });
  });

  it("does not move bots when no healthy reserve is available", async () => {
    const moveBot = vi.fn(async () => undefined);
    const result = await failoverSite("primary", {
      listBots: async () => [{ botKey: "worker", companyId: "c1", pinned: false }],
      selectReserve: async () => null,
      moveBot,
      markUnavailable: async () => undefined,
    });
    expect(moveBot).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["worker"]);
  });
});
