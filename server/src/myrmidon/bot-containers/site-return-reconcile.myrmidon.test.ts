import { describe, expect, it, vi } from "vitest";
import { reconcileSiteReturn, type SiteReturnReconcileDeps } from "./site-return-reconcile.js";
import { isSiteHealthEnabled, siteStatusIsReachable } from "./site-health-flag.js";

function world(over: Partial<SiteReturnReconcileDeps> & { containers?: Array<{ botKey: string; state: string }> } = {}) {
  const calls: string[] = [];
  const deps: SiteReturnReconcileDeps = {
    listContainers: async () => over.containers ?? [],
    registryBotKeys: async () => new Set(),
    failedOverBotKeys: async () => new Set(),
    movingBotKeys: async () => new Set(),
    stop: async (k) => void calls.push(`stop:${k}`),
    quarantine: async (k) => void calls.push(`quarantine:${k}`),
    ...over,
  };
  return { deps, calls };
}

describe("reconcileSiteReturn", () => {
  it("leaves the containers of bots the registry puts on the site alone", async () => {
    const { deps, calls } = world({
      containers: [{ botKey: "mine", state: "running" }],
      registryBotKeys: async () => new Set(["mine"]),
    });
    expect(await reconcileSiteReturn("s", deps)).toEqual({ stopped: [], quarantined: [], kept: ["mine"] });
    expect(calls).toEqual([]);
  });

  it("stops a running container that is not in the registry of the site and keeps its datadir", async () => {
    const { deps, calls } = world({ containers: [{ botKey: "stray", state: "running" }] });
    const r = await reconcileSiteReturn("s", deps);
    expect(calls).toEqual(["stop:stray"]);
    expect(r.quarantined).toEqual([]);
  });

  it("stops and sets aside the copy of a failed-over bot", async () => {
    const { deps, calls } = world({
      containers: [{ botKey: "gone", state: "running" }],
      failedOverBotKeys: async () => new Set(["gone"]),
    });
    await reconcileSiteReturn("s", deps);
    expect(calls).toEqual(["stop:gone", "quarantine:gone"]);
  });

  it("does not stop a container that is already stopped, but still sets a failed-over datadir aside", async () => {
    const { deps, calls } = world({
      containers: [{ botKey: "gone", state: "stopped" }, { botKey: "stray", state: "missing" }],
      failedOverBotKeys: async () => new Set(["gone"]),
    });
    await reconcileSiteReturn("s", deps);
    expect(calls).toEqual(["quarantine:gone"]);
  });

  it("sets aside the datadir of a failed-over bot the agent no longer lists", async () => {
    const { deps, calls } = world({ failedOverBotKeys: async () => new Set(["gone"]) });
    await reconcileSiteReturn("s", deps);
    expect(calls).toEqual(["quarantine:gone"]);
  });

  it("leaves a bot with an unfinished move to that move", async () => {
    const { deps, calls } = world({
      containers: [{ botKey: "moving", state: "running" }],
      movingBotKeys: async () => new Set(["moving"]),
      failedOverBotKeys: async () => new Set(["moving"]),
    });
    const r = await reconcileSiteReturn("s", deps);
    expect(calls).toEqual([]);
    expect(r.kept).toEqual(["moving"]);
  });

  it("tries every container, then reports the ones that failed so the pass is repeated", async () => {
    const stop = vi.fn(async (k: string) => {
      if (k === "a") throw new Error("agent 500");
    });
    const { deps } = world({
      containers: [{ botKey: "a", state: "running" }, { botKey: "b", state: "running" }],
      stop,
    });
    await expect(reconcileSiteReturn("s", deps)).rejects.toThrow(/incomplete.*a: agent 500/);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("is idempotent: a second pass over the result of the first does nothing more", async () => {
    const state = new Map([["gone", "running"]]);
    const calls: string[] = [];
    const deps: SiteReturnReconcileDeps = {
      listContainers: async () => [...state].map(([botKey, s]) => ({ botKey, state: s })),
      registryBotKeys: async () => new Set(),
      failedOverBotKeys: async () => new Set(["gone"]),
      movingBotKeys: async () => new Set(),
      stop: async (k) => void (calls.push(`stop:${k}`), state.set(k, "stopped")),
      quarantine: async (k) => void (calls.push(`quarantine:${k}`), state.delete(k)),
    };
    await reconcileSiteReturn("s", deps);
    await reconcileSiteReturn("s", deps);
    expect(calls).toEqual(["stop:gone", "quarantine:gone", "quarantine:gone"]);
  });
});

describe("the switch behind the T4 changes to existing behavior", () => {
  const on = { MYRMIDON_BOT_CONTAINERS: "1", MYRMIDON_SITE_HEALTH: "1" };
  it("a draining site is reachable only with MYRMIDON_SITE_HEALTH", () => {
    expect(isSiteHealthEnabled({})).toBe(false);
    expect(siteStatusIsReachable("active", {})).toBe(true);
    expect(siteStatusIsReachable("draining", {})).toBe(false);
    expect(siteStatusIsReachable("draining", { MYRMIDON_BOT_CONTAINERS: "1" })).toBe(false);
    expect(siteStatusIsReachable("draining", on)).toBe(true);
    expect(siteStatusIsReachable("quarantined", on)).toBe(false);
    expect(siteStatusIsReachable("disabled", on)).toBe(false);
  });
});
