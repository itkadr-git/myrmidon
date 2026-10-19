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
  it("does not preempt by default and requires sufficient low-priority victims for P0", () => {
    const full = base.sites.map((s) => ({ ...s, allocated: { ...s.allocated, cpus: 8, memoryMb: 8192, pids: 200, bots: 8 } }));
    const p0 = { ...base.bot, priority: "P0" as const };
    expect(decide({ sites: full })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true, bot: p0 })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true, bot: p0, preemptibleBots: [{ siteName: "east", priority: "high", cpus: 8, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true, bot: p0, preemptibleBots: [{ siteName: "east", priority: "P0", cpus: 8, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ sites: full, allowPreemption: true, bot: p0, preemptibleBots: [{ siteName: "east", priority: "low", cpus: 8, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "selected", siteName: "east", preempt: true });
    expect(decide({ sites: full, allowPreemption: true, bot: p0, preemptibleBots: [{ siteName: "east", priority: "low", cpus: 0, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "pending", reason: "capacity_exceeded" });
    expect(decide({ bot: { ...p0, host: "west", hostPinned: true }, sites: full, allowPreemption: true, preemptibleBots: [{ siteName: "west", priority: "low", cpus: Number.NaN, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "pending", reason: "pinned_site_capacity_exceeded" });
    expect(decide({ bot: { ...p0, host: "west", hostPinned: true }, sites: full, allowPreemption: true, preemptibleBots: [{ siteName: "west", priority: "low", cpus: 8, memoryMb: 8192, pids: 200 }] })).toEqual({ kind: "selected", siteName: "west", preempt: true });
  });
  it("rejects preemption when aggregate reclaimed resources or victim count exceed site allocation", () => {
    const p0 = { ...base.bot, priority: "P0" as const, cpus: 8, memoryMb: 4096, pids: 100 };
    const partiallyAllocatedSite = {
      name: "east",
      status: "available" as const,
      capacity: { cpus: 10, memoryMb: 8192, pids: 200, maxBots: 8 },
      allocated: { cpus: 4, memoryMb: 2048, pids: 50, bots: 2 },
    };

    // 1. Reclaimed CPU exceeds allocated CPU (victim claims 5 cpus, allocated is 4)
    expect(decide({
      bot: p0,
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [{ siteName: "east", priority: "low", cpus: 5, memoryMb: 2048, pids: 50 }],
    })).toEqual({ kind: "pending", reason: "capacity_exceeded" });

    // 2. Reclaimed memoryMb exceeds allocated memoryMb (victim claims 2049 Mb, allocated is 2048)
    expect(decide({
      bot: p0,
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [{ siteName: "east", priority: "low", cpus: 4, memoryMb: 2049, pids: 50 }],
    })).toEqual({ kind: "pending", reason: "capacity_exceeded" });

    // 3. Reclaimed pids exceeds allocated pids (victim claims 51 pids, allocated is 50)
    expect(decide({
      bot: p0,
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [{ siteName: "east", priority: "low", cpus: 4, memoryMb: 2048, pids: 51 }],
    })).toEqual({ kind: "pending", reason: "capacity_exceeded" });

    // 4. Reclaimed bot count exceeds allocated bots (3 victims, allocated is 2)
    expect(decide({
      bot: p0,
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [
        { siteName: "east", priority: "low", cpus: 1, memoryMb: 500, pids: 10 },
        { siteName: "east", priority: "low", cpus: 1, memoryMb: 500, pids: 10 },
        { siteName: "east", priority: "low", cpus: 1, memoryMb: 500, pids: 10 },
      ],
    })).toEqual({ kind: "pending", reason: "capacity_exceeded" });

    // 5. Inconsistent zero-allocated snapshot with large reclaimed claim (0 - 100 + 8 <= 10 arithmetic trick)
    const zeroAllocatedSite = {
      name: "east",
      status: "available" as const,
      capacity: { cpus: 10, memoryMb: 8192, pids: 200, maxBots: 8 },
      allocated: { cpus: 0, memoryMb: 0, pids: 0, bots: 0 },
    };
    expect(decide({
      bot: p0,
      sites: [zeroAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [{ siteName: "east", priority: "low", cpus: 100, memoryMb: 10000, pids: 500 }],
    })).toEqual({ kind: "pending", reason: "capacity_exceeded" });

    // 6. Pinned bot over-reclaim returns pinned_site_capacity_exceeded
    expect(decide({
      bot: { ...p0, host: "east", hostPinned: true },
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [{ siteName: "east", priority: "low", cpus: 10, memoryMb: 2048, pids: 50 }],
    })).toEqual({ kind: "pending", reason: "pinned_site_capacity_exceeded" });

    // 7. Valid bounded preemption succeeds when within allocated bounds and fitting post-preemption
    expect(decide({
      bot: p0,
      sites: [partiallyAllocatedSite],
      allowPreemption: true,
      preemptibleBots: [
        { siteName: "east", priority: "low", cpus: 2, memoryMb: 1024, pids: 25 },
        { siteName: "east", priority: "low", cpus: 2, memoryMb: 1024, pids: 25 },
      ],
    })).toEqual({ kind: "selected", siteName: "east", preempt: true });
  });
});
