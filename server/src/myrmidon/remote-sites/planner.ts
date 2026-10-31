export type SiteStatus = "available" | "draining" | "quarantined" | "disabled" | (string & {});
export type Priority = "P0" | "high" | "medium" | "low" | (string & {});

export interface BotPlacementRequest {
  bot: { host?: string | null; hostPinned: boolean; cpus: number; memoryMb: number; pids: number; priority: Priority };
  sites: Array<{
    name: string;
    status: SiteStatus;
    capacity: { cpus: number; memoryMb: number; pids: number; maxBots: number };
    allocated: { cpus: number; memoryMb: number; pids: number; bots: number };
  }>;
  affinity: Array<{ scope: "project" | "company" | "agent"; targetId: string; siteName: string; weight: number }>;
  targets?: { projectId?: string; companyId?: string; agentId?: string };
  /** Verified low-priority victims and their resources, supplied by the caller. */
  preemptibleBots?: Array<{ siteName: string; priority: Priority; cpus: number; memoryMb: number; pids: number }>;
  allowPreemption?: boolean;
}

export type PlacementDecision =
  | { kind: "selected"; siteName: string; preempt: boolean }
  | { kind: "pending"; reason: string };

const numeric = (value: number) => Number.isFinite(value) && value >= 0;
const fits = (site: BotPlacementRequest["sites"][number], bot: BotPlacementRequest["bot"]) =>
  numeric(bot.cpus) && numeric(bot.memoryMb) && numeric(bot.pids) &&
  numeric(site.capacity.cpus) && numeric(site.capacity.memoryMb) && numeric(site.capacity.pids) && numeric(site.capacity.maxBots) &&
  numeric(site.allocated.cpus) && numeric(site.allocated.memoryMb) && numeric(site.allocated.pids) && numeric(site.allocated.bots) &&
  site.allocated.cpus + bot.cpus <= site.capacity.cpus &&
  site.allocated.memoryMb + bot.memoryMb <= site.capacity.memoryMb &&
  site.allocated.pids + bot.pids <= site.capacity.pids &&
  site.allocated.bots + 1 <= site.capacity.maxBots;

const canPreempt = (site: BotPlacementRequest["sites"][number], bot: BotPlacementRequest["bot"], input: BotPlacementRequest) => {
  if (bot.priority !== "P0" || !input.allowPreemption) return false;
  if (!numeric(bot.cpus) || !numeric(bot.memoryMb) || !numeric(bot.pids)) return false;
  if (
    !numeric(site.allocated.cpus) || !numeric(site.allocated.memoryMb) || !numeric(site.allocated.pids) || !numeric(site.allocated.bots) ||
    !numeric(site.capacity.cpus) || !numeric(site.capacity.memoryMb) || !numeric(site.capacity.pids) || !numeric(site.capacity.maxBots)
  ) return false;
  const victims = input.preemptibleBots?.filter((victim) => victim.siteName === site.name && victim.priority === "low") ?? [];
  if (!victims.length || victims.some((victim) => !numeric(victim.cpus) || !numeric(victim.memoryMb) || !numeric(victim.pids))) return false;
  const cpu = victims.reduce((sum, victim) => sum + victim.cpus, 0);
  const memory = victims.reduce((sum, victim) => sum + victim.memoryMb, 0);
  const pids = victims.reduce((sum, victim) => sum + victim.pids, 0);
  return (
    cpu <= site.allocated.cpus &&
    memory <= site.allocated.memoryMb &&
    pids <= site.allocated.pids &&
    victims.length <= site.allocated.bots &&
    site.allocated.cpus - cpu + bot.cpus <= site.capacity.cpus &&
    site.allocated.memoryMb - memory + bot.memoryMb <= site.capacity.memoryMb &&
    site.allocated.pids - pids + bot.pids <= site.capacity.pids &&
    site.allocated.bots - victims.length + 1 <= site.capacity.maxBots
  );
};

export function planBotPlacement(input: BotPlacementRequest): PlacementDecision {
  const { bot, sites } = input;
  if (bot.hostPinned) {
    if (!bot.host) return { kind: "pending", reason: "pinned_host_missing" };
    const pinned = sites.find((site) => site.name === bot.host);
    if (!pinned) return { kind: "pending", reason: "pinned_site_unregistered" };
    if (pinned.status !== "available") return { kind: "pending", reason: "pinned_site_unavailable" };
    if (fits(pinned, bot)) return { kind: "selected", siteName: pinned.name, preempt: false };
    if (canPreempt(pinned, bot, input)) return { kind: "selected", siteName: pinned.name, preempt: true };
    return { kind: "pending", reason: "pinned_site_capacity_exceeded" };
  }

  const eligible = sites.filter((site) => site.status === "available" && fits(site, bot));
  if (!eligible.length) {
    if (!sites.length) return { kind: "pending", reason: "no_sites_registered" };
    if (input.allowPreemption && bot.priority === "P0") {
      const possible = sites.filter((site) => site.status === "available" && canPreempt(site, bot, input)).sort((a, b) => a.name.localeCompare(b.name));
      if (possible.length) return { kind: "selected", siteName: possible[0].name, preempt: true };
    }
    return { kind: "pending", reason: sites.some((site) => site.status === "available") ? "capacity_exceeded" : "no_available_sites" };
  }

  const targets = input.targets ?? {};
  const priorities: Array<["agent" | "company" | "project", string | undefined]> = [
    ["agent", targets.agentId], ["company", targets.companyId], ["project", targets.projectId],
  ];
  const applicable = input.affinity.flatMap((rule) => {
    if (!numeric(rule.weight)) return [];
    const target = priorities.find(([scope, id]) => rule.scope === scope && id === rule.targetId);
    return target ? [{ rule, scopeRank: priorities.findIndex(([scope]) => scope === rule.scope) }] : [];
  });
  const ranked = eligible.map((site) => {
    const matches = applicable.filter(({ rule }) => rule.siteName === site.name);
    const best = matches.sort((a, b) => b.rule.weight - a.rule.weight || a.scopeRank - b.scopeRank)[0];
    return { site, weight: best?.rule.weight ?? 0, affinity: Boolean(best) };
  });
  ranked.sort((a, b) => Number(b.affinity) - Number(a.affinity) || b.weight - a.weight || a.site.name.localeCompare(b.site.name));
  return { kind: "selected", siteName: ranked[0].site.name, preempt: false };
}
