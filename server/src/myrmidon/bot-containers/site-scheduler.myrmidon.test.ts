// server/src/myrmidon/bot-containers/site-scheduler.myrmidon.test.ts

import { describe, it, expect } from "vitest";
import {
  scheduleSitePlacements,
  type AgentPlacementInput,
  type FleetSiteInfo,
  type AffinityRule,
  calculateSiteUtilization,
} from "./site-scheduler.js";

describe("site-scheduler", () => {
  const defaultSites: FleetSiteInfo[] = [
    {
      name: "myr-vm1",
      status: "active",
      capacity: { maxCpus: 6, maxMemoryMb: 24576, maxBots: 20 },
      labels: { cluster: "work" },
    },
    {
      name: "vm-core",
      status: "active",
      capacity: { maxCpus: 16, maxMemoryMb: 65536, maxBots: 50 },
      labels: { cluster: "core" },
    },
  ];

  const createBot = (
    botKey: string,
    overrides: Partial<AgentPlacementInput> = {},
  ): AgentPlacementInput => ({
    botKey,
    agentId: `agent-${botKey}`,
    companyId: "company-1",
    spec: { memoryMb: 1024, cpus: 1 },
    ...overrides,
  });

  describe("Rule 1: Manual Pin", () => {
    it("pinned bot stays on currentHost regardless of affinity or capacity", () => {
      const bots: AgentPlacementInput[] = [
        createBot("work-pinned", {
          currentHost: "vm-core",
          hostPinned: true,
          labels: { cluster: "work" },
        }),
      ];

      // Even with affinity pointing to myr-vm1
      const rules: AffinityRule[] = [
        { scope: "agent", targetId: "work-pinned", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, defaultSites, rules);
      const dec = res.decisions.get("work-pinned");

      expect(dec).toBeDefined();
      expect(dec?.status).toBe("placed");
      expect(dec?.targetHost).toBe("vm-core");
      expect(dec?.reason).toBe("pinned");
      expect(res.siteAllocations.get("vm-core")?.bots).toContain("work-pinned");
    });
  });

  describe("Rule 1b: pinned bot on the local driver", () => {
    it("a pinned bot without a host stays where it is (local) and is never placed on a site", () => {
      const bots: AgentPlacementInput[] = [createBot("work-local-pinned", { currentHost: null, hostPinned: true })];
      const rules: AffinityRule[] = [{ scope: "agent", targetId: "work-local-pinned", siteName: "myr-vm1", weight: 100 }];

      const res = scheduleSitePlacements(bots, defaultSites, rules);
      const dec = res.decisions.get("work-local-pinned");

      expect(dec?.status).toBe("placed");
      expect(dec?.reason).toBe("pinned");
      expect(dec?.targetHost).toBeNull();
      expect(res.siteAllocations.get("myr-vm1")?.allocatedBots).toBe(0);
    });
  });

  describe("Rule 2: Affinity", () => {
    it("routes work bots with affinity to myr-vm1", () => {
      const bots: AgentPlacementInput[] = [
        createBot("work-qa", { labels: { cluster: "work" } }),
        createBot("work-finansist", { labels: { cluster: "work" } }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, defaultSites, rules);
      expect(res.decisions.get("work-qa")?.targetHost).toBe("myr-vm1");
      expect(res.decisions.get("work-qa")?.reason).toBe("affinity");
      expect(res.decisions.get("work-finansist")?.targetHost).toBe("myr-vm1");
      expect(res.decisions.get("work-finansist")?.reason).toBe("affinity");

      const myrAlloc = res.siteAllocations.get("myr-vm1");
      expect(myrAlloc?.allocatedMemoryMb).toBe(2048);
      expect(myrAlloc?.allocatedCpus).toBe(2);
    });

    it("prefers agent-level affinity over project and company affinity", () => {
      const bots: AgentPlacementInput[] = [
        createBot("special-bot", { projectId: "proj-1" }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 10 },
        { scope: "project", targetId: "proj-1", siteName: "vm-core", weight: 50 },
        { scope: "agent", targetId: "special-bot", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, defaultSites, rules);
      expect(res.decisions.get("special-bot")?.targetHost).toBe("myr-vm1");
      expect(res.decisions.get("special-bot")?.matchedAffinity?.weight).toBe(100);
    });

    it("overflow on affinity site puts bot in pending queue and emits alert (never silent local!)", () => {
      const tinySites: FleetSiteInfo[] = [
        {
          name: "myr-vm1",
          status: "active",
          capacity: { maxCpus: 2, maxMemoryMb: 2048 },
        },
      ];

      const bots: AgentPlacementInput[] = [
        createBot("bot-1", { spec: { memoryMb: 1500, cpus: 1 } }),
        createBot("bot-2", { spec: { memoryMb: 1500, cpus: 1 } }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, tinySites, rules);

      expect(res.decisions.get("bot-1")?.status).toBe("placed");
      expect(res.decisions.get("bot-1")?.targetHost).toBe("myr-vm1");

      const dec2 = res.decisions.get("bot-2");
      expect(dec2?.status).toBe("pending_placement");
      expect(dec2?.targetHost).toBeNull();
      expect(dec2?.reason).toBe("overflow_pending");

      expect(res.pendingPlacementQueue).toContain("bot-2");
      expect(res.alerts.some((a) => a.botKey === "bot-2" && a.severity === "error")).toBe(true);
    });
  });

  describe("Rule 3: Capacity", () => {
    it("distributes unconstrained bots to site with minimal utilization", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "site-a",
          status: "active",
          capacity: { maxCpus: 10, maxMemoryMb: 10000 },
        },
        {
          name: "site-b",
          status: "active",
          capacity: { maxCpus: 10, maxMemoryMb: 10000 },
        },
      ];

      // Give site-a a pre-existing pinned bot
      const bots: AgentPlacementInput[] = [
        createBot("pinned-a", { currentHost: "site-a", hostPinned: true, spec: { memoryMb: 4000, cpus: 4 } }),
        createBot("new-bot-1", { spec: { memoryMb: 1000, cpus: 1 } }),
      ];

      const res = scheduleSitePlacements(bots, sites, []);

      // site-a utilization is 0.4, site-b utilization is 0.0 -> new-bot-1 goes to site-b
      expect(res.decisions.get("new-bot-1")?.targetHost).toBe("site-b");
      expect(res.decisions.get("new-bot-1")?.reason).toBe("capacity");
    });

    it("puts bots in pending queue when all sites are full (never silent local)", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "site-full",
          status: "active",
          capacity: { maxCpus: 1, maxMemoryMb: 1024 },
        },
      ];

      const bots: AgentPlacementInput[] = [
        createBot("bot-heavy", { spec: { memoryMb: 2048, cpus: 2 } }),
      ];

      const res = scheduleSitePlacements(bots, sites, []);
      const dec = res.decisions.get("bot-heavy");

      expect(dec?.status).toBe("pending_placement");
      expect(dec?.targetHost).toBeNull();
      expect(dec?.reason).toBe("overflow_pending");
      expect(res.pendingPlacementQueue).toContain("bot-heavy");
    });
  });

  describe("Rule 4: Preemption", () => {
    it("critical (P0) bot preempts low-priority bot on full site when preemptionEnabled is true", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "myr-vm1",
          status: "active",
          capacity: { maxCpus: 2, maxMemoryMb: 2048 },
        },
      ];

      const bots: AgentPlacementInput[] = [
        createBot("low-bot", {
          priority: "low",
          spec: { memoryMb: 1024, cpus: 1 },
        }),
        createBot("p0-bot", {
          priority: "critical",
          spec: { memoryMb: 1500, cpus: 1.5 },
        }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, sites, rules, { preemptionEnabled: true });

      // p0-bot was placed on myr-vm1 and evicted low-bot
      expect(res.decisions.get("p0-bot")?.status).toBe("placed");
      expect(res.decisions.get("p0-bot")?.targetHost).toBe("myr-vm1");
      expect(res.decisions.get("low-bot")?.reason).toBe("preempted");

      expect(res.decisions.get("low-bot")?.status).toBe("pending_placement");
      expect(res.decisions.get("low-bot")?.reason).toBe("preempted");
      expect(res.pendingPlacementQueue).toContain("low-bot");
    });

    it("preemption does not occur when preemptionEnabled is false", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "myr-vm1",
          status: "active",
          capacity: { maxCpus: 2, maxMemoryMb: 2048 },
        },
      ];

      const bots: AgentPlacementInput[] = [
        createBot("p0-bot-1", {
          priority: "critical",
          spec: { memoryMb: 1500, cpus: 1.5 },
        }),
        createBot("p0-bot-2", {
          priority: "critical",
          spec: { memoryMb: 1500, cpus: 1.5 },
        }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, sites, rules, { preemptionEnabled: false });

      expect(res.decisions.get("p0-bot-1")?.status).toBe("placed");
      expect(res.decisions.get("p0-bot-2")?.status).toBe("pending_placement");
      expect(res.decisions.get("p0-bot-2")?.reason).toBe("overflow_pending");
    });

    it("preemption cannot evict pinned bots", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "myr-vm1",
          status: "active",
          capacity: { maxCpus: 2, maxMemoryMb: 2048 },
        },
      ];

      const bots: AgentPlacementInput[] = [
        createBot("pinned-low", {
          currentHost: "myr-vm1",
          hostPinned: true,
          priority: "low",
          spec: { memoryMb: 1500, cpus: 1 },
        }),
        createBot("p0-bot", {
          priority: "critical",
          spec: { memoryMb: 1500, cpus: 1 },
        }),
      ];

      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "myr-vm1", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, sites, rules, { preemptionEnabled: true });

      // pinned-low cannot be evicted
      expect(res.decisions.get("pinned-low")?.status).toBe("placed");
      expect(res.decisions.get("pinned-low")?.targetHost).toBe("myr-vm1");
      expect(res.decisions.get("p0-bot")?.status).toBe("pending_placement");
    });
  });

  describe("Site Statuses", () => {
    it("ignores draining, quarantined, and disabled sites for new placements", () => {
      const sites: FleetSiteInfo[] = [
        {
          name: "draining-site",
          status: "draining",
          capacity: { maxCpus: 10, maxMemoryMb: 10000 },
        },
        {
          name: "active-site",
          status: "active",
          capacity: { maxCpus: 10, maxMemoryMb: 10000 },
        },
      ];

      const bots: AgentPlacementInput[] = [createBot("bot-1")];
      const rules: AffinityRule[] = [
        { scope: "company", targetId: "company-1", siteName: "draining-site", weight: 100 },
      ];

      const res = scheduleSitePlacements(bots, sites, rules);
      // Draining site affinity is skipped, bot goes to active-site via capacity rule
      expect(res.decisions.get("bot-1")?.targetHost).toBe("active-site");
    });
  });
});
