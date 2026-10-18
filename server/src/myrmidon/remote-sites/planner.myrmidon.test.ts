import { describe, expect, it } from "vitest";
import { planBotPlacement, type BotPlacementRequest } from "./planner.js";

const base: BotPlacementRequest = {
  bot: { host: null, hostPinned: false, cpus: 1, memoryMb: 256, pids: 20, priority: "low" },
  sites: [
    { name: "west", status: "available", capacity: { cpus: 8, memoryMb: 8192, pids: 200, maxBots: 8 }, allocated: { cpus: 0, memoryMb: 0, pids: 0, bots: 0 } },
    { name: "east", status: "available", capacity: { cpus: 8, memoryMb: 8192, pids: 200, maxBots: 8 }, allocated: { cpus: 0, memoryMb: 0, pids: 0, bots: 0 } },
  ],
  affinity: [],
};
const decide = (overrides: Partial<BotPlacementRequest>) => planBotPlacement({ ...base, ...overrides });

describe("planBotPlacement", () => {
  it("keeps a pin ahead of affinity and other capacity", () => {
    expect(decide({ bot: { ...base.bot, host: "west", hostPinned: true }, affinity: [{ scope: "agent", targetId: "a", siteName: "east", weight: 999 }], targets: { agentId: "a" } })).toEqual({ kind: "selected", siteName: "west", preempt: false });
  });
  it("does not move a pinned bot when its site is unavailable or missing", () => {
    const bot = { ...base.bot, host: "west", hostPinned: true };
    expect(decide({ bot, sites: base.sites.map((s) => ({ ...s, status: s.name === "west" ? ("draining" as const) : s.status })) })).toEqual({ kind: "pending", reason: "pinned_site_unavailable" });
    expect(decide({ bot, sites: [] })).toEqual({ kind: "pending", reason: "pinned_site_unregistered" });
  });
  it("selects applicable affinity before capacity ranking", () => {
    expect(decide({ affinity: [{ scope: "company", targetId: "c", siteName: "east", weight: 1 }], targets: { companyId: "c" } })).toMatchObject({ kind: "selected", siteName: "east" });
  });
  it("breaks equal scores by site name consistently", () => {
    expect(decide({ sites: [...base.sites].reverse() })).toMatchObject({ kind: "selected", siteName: "east" });
    expect(decide({ sites: [...base.sites].reverse() })).toEqual(decide({}));
  });
  it("respects CPU, memory, pids, and maxBots independently", () => {
    for (const field of ["cpus", "memoryMb", "pids", "maxBots"] as const) {
      const site = { ...base.sites[0], capacity: { ...base.sites[0].capacity, [field]: 0 } };
      expect(decide({ sites: [site] })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    }
  });
  it("does not select malformed resource snapshots or use non-finite affinity weights", () => {
    const site = { ...base.sites[0], allocated: { ...base.sites[0].allocated, cpus: Number.NaN } };
    expect(decide({ sites: [site] })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ affinity: [{ scope: "agent", targetId: "a", siteName: "east", weight: Number.NaN }], targets: { agentId: "a" } }))
      .toMatchObject({ kind: "selected", siteName: "east" });
  });
  it("returns explicit pending for an empty registry and capacity overflow", () => {
    expect(decide({ sites: [] })).toEqual({ kind: "pending", reason: "no_sites_registered" });
    expect(decide({ sites: base.sites.map((s) => ({ ...s, capacity: { ...s.capacity, cpus: 0 } })) })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
  });
  it.each(["draining", "quarantined", "disabled"])("excludes %s sites", (status) => {
    expect(decide({ sites: base.sites.map((s) => ({ ...s, status })) })).toEqual({ kind: "pending", reason: "no_available_sites" });
  });
  it("does not preempt by default and limits enabled preemption to P0", () => {
    const full = base.sites.map((s) => ({ ...s, capacity: { ...s.capacity, cpus: 0 } }));
    expect(decide({ sites: full })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true, bot: { ...base.bot, priority: "P0" } })).toEqual({ kind: "selected", siteName: "east", preempt: true });
  });
});
