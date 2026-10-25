import { beforeEach, describe, expect, it, vi } from "vitest";
import { failoverSite, type FailoverBot, type SiteFailoverDeps } from "./site-failover-orchestrator.js";
import { readFleetSiteMetrics, resetFleetSiteMetrics } from "./fleet-site-metrics.js";

function deps(bots: FailoverBot[], over: Partial<SiteFailoverDeps> = {}) {
  const calls: string[] = [];
  const d: SiteFailoverDeps = {
    listBots: async () => bots,
    selectReserve: async () => "local",
    hasReplica: async () => true,
    requeueRuns: async (botKey) => {
      calls.push(`requeue:${botKey}`);
      return 2;
    },
    moveBot: async ({ botKey, dstSite }) => {
      calls.push(`move:${botKey}->${dstSite}`);
      return { ok: true, claimed: true };
    },
    markUnavailable: async ({ botKey, reason }) => {
      calls.push(`unavailable:${botKey}:${reason}`);
    },
    ...over,
  };
  return { d, calls };
}

describe("failoverSite", () => {
  beforeEach(() => resetFleetSiteMetrics());

  it("requeues the runs of a bot before it moves, and moves it from its replica to the reserve", async () => {
    const { d, calls } = deps([{ botKey: "a", companyId: "c", pinned: false }]);
    const result = await failoverSite("myr-vm1", d);

    expect(calls).toEqual(["requeue:a", "move:a->local"]);
    expect(result).toEqual({ moved: ["a"], unavailable: [], skipped: [], requeuedRuns: 2 });
    const metrics = readFleetSiteMetrics();
    expect(metrics.retriesTotal).toEqual([{ site: "myr-vm1", count: 2 }]);
    expect(metrics.movesTotal.find((m) => m.result === "done")?.count).toBe(1);
  });

  it("never moves a pinned bot and never touches its runs", async () => {
    const { d, calls } = deps([
      { botKey: "pinned", companyId: "c", pinned: true },
      { botKey: "free", companyId: "c", pinned: false },
    ]);
    const result = await failoverSite("myr-vm1", d);

    expect(calls).toEqual(["unavailable:pinned:pinned", "requeue:free", "move:free->local"]);
    expect(result.unavailable).toEqual(["pinned"]);
    expect(result.moved).toEqual(["free"]);
  });

  it("a bot without a replica is not moved and its runs are left for the returning site", async () => {
    const { d, calls } = deps([{ botKey: "a", companyId: "c", pinned: false }], { hasReplica: async () => false });
    const result = await failoverSite("myr-vm1", d);

    expect(calls).toEqual(["unavailable:a:no_replica"]);
    expect(result.unavailable).toEqual(["a"]);
    expect(readFleetSiteMetrics().movesTotal.find((m) => m.result === "unavailable")?.count).toBe(1);
  });

  it("a bot with no reserve site is reported, not moved", async () => {
    const { d, calls } = deps([{ botKey: "a", companyId: "c", pinned: false }], { selectReserve: async () => null });
    await failoverSite("myr-vm1", d);
    expect(calls).toEqual(["unavailable:a:no_reserve"]);
  });

  it("a move held by another process is neither counted nor repeated", async () => {
    const { d } = deps([{ botKey: "a", companyId: "c", pinned: false }], { moveBot: async () => ({ ok: false, claimed: false }) });
    const result = await failoverSite("myr-vm1", d);
    expect(result.skipped).toEqual(["a"]);
    expect(readFleetSiteMetrics().movesTotal.every((m) => m.count === 0)).toBe(true);
  });

  it("one bot's failure does not stop the others and is counted as failed", async () => {
    const error = vi.fn();
    const { d, calls } = deps(
      [
        { botKey: "bad", companyId: "c", pinned: false },
        { botKey: "good", companyId: "c", pinned: false },
      ],
      {
        moveBot: async ({ botKey }) => {
          if (botKey === "bad") throw new Error("restore failed");
          return { ok: true, claimed: true };
        },
        log: { warn: vi.fn(), error },
      },
    );
    const result = await failoverSite("myr-vm1", d);

    expect(result.skipped).toEqual(["bad"]);
    expect(result.moved).toEqual(["good"]);
    expect(error).toHaveBeenCalledOnce();
    expect(calls).toContain("requeue:good");
    expect(readFleetSiteMetrics().movesTotal.find((m) => m.result === "failed")?.count).toBe(1);
  });

  it("a move that ended in failed is counted as failed, not done", async () => {
    const { d } = deps([{ botKey: "a", companyId: "c", pinned: false }], { moveBot: async () => ({ ok: false, claimed: true }) });
    const result = await failoverSite("myr-vm1", d);
    expect(result.moved).toEqual([]);
    expect(result.skipped).toEqual(["a"]);
    expect(readFleetSiteMetrics().movesTotal.find((m) => m.result === "failed")?.count).toBe(1);
  });
});
