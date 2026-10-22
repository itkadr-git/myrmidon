// server/src/myrmidon/bot-containers/site-scheduler.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): pure placement scheduler for bot containers across fleet sites.
//
// CONVENTIONS: Pure functions, zero I/O, no DB or network calls.
// Input: agent cards/specs (with pin and priority), affinity rules, fleet sites with capacity.
// Output: placement decisions (container.host), pending placement queue, preemption records, alerts.
//
// Priority rules (§3.1):
// 1. Manual pin: container.hostPinned=true wins over everything (affinity, failover, capacity).
// 2. Affinity: rules in myrmidon_fleet_affinity (scope=agent|project|company) + site labels.
//    work-affinity -> work bots to myr-vm1.
// 3. Capacity: site with minimal utilization ((allocMem/maxMem + allocCpu/maxCpu)/2).
//    Overflow -> bot goes to pending placement queue (never silent local fallback!).
// 4. Preemption: critical (P0) bot can preempt low-priority bot on an overfull site only
//    when preemptionEnabled=true.

export interface SiteCapacity {
  maxCpus: number;
  maxMemoryMb: number;
  maxPids?: number;
  maxBots?: number;
}

export interface FleetSiteInfo {
  name: string;
  status: "active" | "draining" | "quarantined" | "disabled";
  capacity: SiteCapacity;
  labels?: Record<string, string>;
}

export interface AgentPlacementInput {
  botKey: string;
  agentId: string;
  companyId: string;
  projectId?: string | null;
  priority?: "critical" | "high" | "medium" | "low" | string | null;
  currentHost?: string | null;
  hostPinned?: boolean;
  spec: {
    memoryMb: number;
    cpus: number;
    pidsLimit?: number;
  };
  labels?: Record<string, string>;
}

export interface AffinityRule {
  scope: "project" | "company" | "agent";
  targetId: string;
  siteName: string;
  weight: number;
}

export interface SchedulerOptions {
  preemptionEnabled?: boolean;
}

export type PlacementReason = "pinned" | "affinity" | "capacity" | "preempted" | "overflow_pending";

export interface PlacementDecision {
  botKey: string;
  agentId: string;
  targetHost: string | null; // null when in pending placement
  status: "placed" | "pending_placement";
  reason: PlacementReason;
  matchedAffinity?: AffinityRule;
  preemptedBotKeys?: string[];
  alert?: string;
}

export interface SiteAllocation {
  allocatedMemoryMb: number;
  allocatedCpus: number;
  allocatedBots: number;
  bots: string[];
}

export interface SchedulerAlert {
  botKey: string;
  siteName?: string;
  message: string;
  severity: "warning" | "error";
}

export interface SchedulerResult {
  decisions: Map<string, PlacementDecision>;
  siteAllocations: Map<string, SiteAllocation>;
  pendingPlacementQueue: string[]; // botKeys of bots waiting for placement
  alerts: SchedulerAlert[];
}

/** Computes normalized utilization (0.0 .. 1.0+) of a site. */
export function calculateSiteUtilization(capacity: SiteCapacity, alloc: SiteAllocation): number {
  const memRatio = capacity.maxMemoryMb > 0 ? alloc.allocatedMemoryMb / capacity.maxMemoryMb : 1.0;
  const cpuRatio = capacity.maxCpus > 0 ? alloc.allocatedCpus / capacity.maxCpus : 1.0;
  return (memRatio + cpuRatio) / 2;
}

/** Checks whether adding spec fits into site capacity without exceeding limits. */
export function fitsInSite(capacity: SiteCapacity, alloc: SiteAllocation, spec: { memoryMb: number; cpus: number }): boolean {
  if (alloc.allocatedMemoryMb + spec.memoryMb > capacity.maxMemoryMb) return false;
  if (alloc.allocatedCpus + spec.cpus > capacity.maxCpus) return false;
  if (capacity.maxBots !== undefined && alloc.allocatedBots + 1 > capacity.maxBots) return false;
  return true;
}

/** Finds the best matching affinity rule for an agent. */
export function matchAffinityRule(
  agent: AgentPlacementInput,
  rules: readonly AffinityRule[],
  sites: ReadonlyMap<string, FleetSiteInfo>,
): AffinityRule | null {
  const matches: AffinityRule[] = [];

  for (const rule of rules) {
    const site = sites.get(rule.siteName);
    if (!site || site.status !== "active") continue;

    if (rule.scope === "agent" && (rule.targetId === agent.botKey || rule.targetId === agent.agentId)) {
      matches.push(rule);
    } else if (rule.scope === "project" && agent.projectId && rule.targetId === agent.projectId) {
      matches.push(rule);
    } else if (rule.scope === "company" && rule.targetId === agent.companyId) {
      matches.push(rule);
    }
  }

  // Also check label-based affinity (e.g. agent.labels["cluster"] === "work" or "company-work" -> myr-vm1)
  if (agent.labels) {
    for (const [key, val] of Object.entries(agent.labels)) {
      for (const site of sites.values()) {
        if (site.status !== "active") continue;
        if (site.labels && site.labels[key] === val) {
          matches.push({
            scope: "agent",
            targetId: agent.botKey,
            siteName: site.name,
            weight: 50, // default label affinity weight
          });
        }
      }
    }
  }

  if (matches.length === 0) return null;
  // Sort descending by weight
  matches.sort((a, b) => b.weight - a.weight);
  return matches[0];
}

/**
 * Returns the botKey of a critical (non-pinned) bot already placed on the site whose removal
 * would make `agent` fit, or null when the overflow is not caused by a critical bot.
 */
function findPreemptingCritical(
  siteName: string,
  site: FleetSiteInfo,
  alloc: SiteAllocation,
  agent: AgentPlacementInput,
  decisions: ReadonlyMap<string, PlacementDecision>,
  botMap: ReadonlyMap<string, AgentPlacementInput>,
): string | null {
  const criticals = alloc.bots
    .map((k) => botMap.get(k))
    .filter(
      (b): b is AgentPlacementInput =>
        b !== undefined &&
        !b.hostPinned &&
        b.priority === "critical" &&
        decisions.get(b.botKey)?.targetHost === siteName,
    );
  if (criticals.length === 0) return null;
  const without: SiteAllocation = {
    allocatedMemoryMb: alloc.allocatedMemoryMb - criticals.reduce((n, b) => n + b.spec.memoryMb, 0),
    allocatedCpus: alloc.allocatedCpus - criticals.reduce((n, b) => n + b.spec.cpus, 0),
    allocatedBots: alloc.allocatedBots - criticals.length,
    bots: [],
  };
  return fitsInSite(site.capacity, without, agent.spec) ? criticals[0].botKey : null;
}

/**
 * Pure scheduling function for bot container placement across fleet sites.
 */
export function scheduleSitePlacements(
  agents: readonly AgentPlacementInput[],
  sitesList: readonly FleetSiteInfo[],
  affinityRules: readonly AffinityRule[] = [],
  options: SchedulerOptions = {},
): SchedulerResult {
  const sites = new Map<string, FleetSiteInfo>();
  const allocations = new Map<string, SiteAllocation>();
  for (const site of sitesList) {
    sites.set(site.name, site);
    allocations.set(site.name, {
      allocatedMemoryMb: 0,
      allocatedCpus: 0,
      allocatedBots: 0,
      bots: [],
    });
  }

  const decisions = new Map<string, PlacementDecision>();
  const pendingQueue: string[] = [];
  const alerts: SchedulerAlert[] = [];

  // Helper to allocate a bot to a site
  function allocate(siteName: string, bot: AgentPlacementInput): void {
    const alloc = allocations.get(siteName);
    if (!alloc) return;
    alloc.allocatedMemoryMb += bot.spec.memoryMb;
    alloc.allocatedCpus += bot.spec.cpus;
    alloc.allocatedBots += 1;
    alloc.bots.push(bot.botKey);
  }

  // 1. Process Pinned bots first: pinned bots take precedence over everything.
  const unpinnedBots: AgentPlacementInput[] = [];
  const botMap = new Map<string, AgentPlacementInput>();

  for (const agent of agents) {
    botMap.set(agent.botKey, agent);
    if (agent.hostPinned) {
      // Pinned bot stays where it is (a named site, or the local driver when currentHost is
      // null) even if the site is not active or over capacity.
      const site = agent.currentHost ? sites.get(agent.currentHost) : undefined;
      if (agent.currentHost) allocate(agent.currentHost, agent);
      decisions.set(agent.botKey, {
        botKey: agent.botKey,
        agentId: agent.agentId,
        targetHost: agent.currentHost ?? null,
        status: "placed",
        reason: "pinned",
      });
      if (agent.currentHost && site && !fitsInSite(site.capacity, allocations.get(agent.currentHost)!, { memoryMb: 0, cpus: 0 })) {
        alerts.push({
          botKey: agent.botKey,
          siteName: agent.currentHost,
          message: `Pinned bot "${agent.botKey}" exceeds site capacity on "${agent.currentHost}"`,
          severity: "warning",
        });
      }
    } else {
      unpinnedBots.push(agent);
    }
  }

  // Sort unpinned bots by priority: critical (P0) > high > medium > low
  const priorityRank: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  unpinnedBots.sort((a, b) => {
    const pA = priorityRank[a.priority ?? "medium"] ?? 2;
    const pB = priorityRank[b.priority ?? "medium"] ?? 2;
    return pB - pA;
  });

  // 2. Process bots with affinity rules
  const remainingBots: AgentPlacementInput[] = [];

  for (const agent of unpinnedBots) {
    const matchedAffinity = matchAffinityRule(agent, affinityRules, sites);
    if (matchedAffinity) {
      const targetSiteName = matchedAffinity.siteName;
      const targetSite = sites.get(targetSiteName)!;
      const alloc = allocations.get(targetSiteName)!;

      if (fitsInSite(targetSite.capacity, alloc, agent.spec)) {
        allocate(targetSiteName, agent);
        decisions.set(agent.botKey, {
          botKey: agent.botKey,
          agentId: agent.agentId,
          targetHost: targetSiteName,
          status: "placed",
          reason: "affinity",
          matchedAffinity,
        });
      } else {
        // Preemption (low -> P0, only behind the flag). Bots are placed in priority order, so a
        // critical bot has already taken its room by the time a low bot is tried: the low bot is
        // "preempted" when it would have fitted on the site without the critical bots placed there.
        const preemptor =
          options.preemptionEnabled && agent.priority === "low"
            ? findPreemptingCritical(targetSiteName, targetSite, alloc, agent, decisions, botMap)
            : null;
        if (preemptor) {
          const message = `Bot "${agent.botKey}" preempted on "${targetSiteName}" by critical bot "${preemptor}"`;
          decisions.set(agent.botKey, {
            botKey: agent.botKey,
            agentId: agent.agentId,
            targetHost: null,
            status: "pending_placement",
            reason: "preempted",
            matchedAffinity,
            alert: `Preempted by critical bot "${preemptor}"`,
          });
          pendingQueue.push(agent.botKey);
          alerts.push({ botKey: agent.botKey, siteName: targetSiteName, message, severity: "warning" });
          const preemptorDecision = decisions.get(preemptor)!;
          preemptorDecision.preemptedBotKeys = [...(preemptorDecision.preemptedBotKeys ?? []), agent.botKey];
        }

        if (!preemptor) {
          // Overflow on affinity site! NEVER silent local fallback!
          decisions.set(agent.botKey, {
            botKey: agent.botKey,
            agentId: agent.agentId,
            targetHost: null,
            status: "pending_placement",
            reason: "overflow_pending",
            matchedAffinity,
            alert: `Capacity overflow on affinity site "${targetSiteName}"`,
          });
          pendingQueue.push(agent.botKey);
          alerts.push({
            botKey: agent.botKey,
            siteName: targetSiteName,
            message: `Affinity site "${targetSiteName}" overflow for bot "${agent.botKey}", queued in pending placement`,
            severity: "error",
          });
        }
      }
    } else {
      remainingBots.push(agent);
    }
  }

  // 3. Process remaining bots by Capacity (minimal utilization)
  for (const agent of remainingBots) {
    const candidates = Array.from(sites.values())
      .filter((s) => s.status === "active")
      .filter((s) => fitsInSite(s.capacity, allocations.get(s.name)!, agent.spec));

    if (candidates.length > 0) {
      // Pick candidate with minimum utilization
      candidates.sort((a, b) => {
        const utilA = calculateSiteUtilization(a.capacity, allocations.get(a.name)!);
        const utilB = calculateSiteUtilization(b.capacity, allocations.get(b.name)!);
        return utilA - utilB;
      });

      const chosenSite = candidates[0];
      allocate(chosenSite.name, agent);
      decisions.set(agent.botKey, {
        botKey: agent.botKey,
        agentId: agent.agentId,
        targetHost: chosenSite.name,
        status: "placed",
        reason: "capacity",
      });
    } else {
      // No site has enough capacity -> pending placement queue!
      decisions.set(agent.botKey, {
        botKey: agent.botKey,
        agentId: agent.agentId,
        targetHost: null,
        status: "pending_placement",
        reason: "overflow_pending",
        alert: "No site with sufficient capacity",
      });
      pendingQueue.push(agent.botKey);
      alerts.push({
        botKey: agent.botKey,
        message: `No site with sufficient capacity for bot "${agent.botKey}", queued in pending placement`,
        severity: "error",
      });
    }
  }

  return {
    decisions,
    siteAllocations: allocations,
    pendingPlacementQueue: pendingQueue,
    alerts,
  };
}
