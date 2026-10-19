// server/src/myrmidon/bot-containers/site-scheduler-lane.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): 30s background sweep for site-scheduler.
//
// Runs every 30s via laneInterval.
// Reads agent cards, fleet sites, and affinity rules.
// Computes desired placement vs current placement.
// Updates container.host when desired placement differs and bot is not pinned.
// Leaves pinned bots untouched.
// Handles pending placement on overflow without silent local fallback.

import { laneInterval } from "../monitoring/board-load/lanes.js";
import { createSiteHealthMonitor, type MonitoredSite } from "./site-health-monitor.js";
import { createSiteHealthSnapshot, type SiteHealthSnapshot } from "../../../../packages/shared/src/remote-sites/health-reducer.js";
import {
  scheduleSitePlacements,
  type AgentPlacementInput,
  type FleetSiteInfo,
  type AffinityRule,
  type SchedulerResult,
} from "./site-scheduler.js";
import { cardFleetHost } from "./fleetd-hosts.js";

export interface ScheduledAgentCard {
  id: string;
  companyId: string;
  projectId?: string | null;
  priority?: string | null;
  adapterConfig: Record<string, unknown>;
}

export interface SiteSchedulerLaneDeps {
  listAgents(): Promise<ScheduledAgentCard[]>;
  listSites(companyId: string): Promise<FleetSiteInfo[]>;
  listAffinityRules(companyId: string): Promise<AffinityRule[]>;
  saveAdapterConfig(agentId: string, adapterConfig: Record<string, unknown>): Promise<void>;
  listHealthSites?(): Promise<MonitoredSite[]>;
  loadSiteHealth?(siteName: string): Promise<SiteHealthSnapshot>;
  saveSiteHealth?(siteName: string, snapshot: SiteHealthSnapshot): Promise<void>;
  fenceSite?(siteName: string): Promise<void>;
  failoverSite?(siteName: string): Promise<void>;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
  intervalMs?: number;
  preemptionEnabled?: boolean;
}

export const SITE_SCHEDULER_INTERVAL_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractBotSpec(card: Record<string, unknown>): { botKey: string; memoryMb: number; cpus: number; pidsLimit?: number } | null {
  const container = isRecord(card.container) ? card.container : null;
  if (!container || typeof container.botKey !== "string") return null;

  const memoryMb = typeof container.memoryMb === "number" && container.memoryMb > 0 ? container.memoryMb : 1024;
  const cpus = typeof container.cpus === "number" && container.cpus > 0 ? container.cpus : 1;
  const pidsLimit = typeof container.pidsLimit === "number" ? container.pidsLimit : undefined;

  return {
    botKey: container.botKey,
    memoryMb,
    cpus,
    pidsLimit,
  };
}

export function startSiteSchedulerLane(deps: SiteSchedulerLaneDeps): {
  stop: () => void;
  tick: () => Promise<SchedulerResult>;
} {
  const intervalMs = deps.intervalMs ?? SITE_SCHEDULER_INTERVAL_MS;
  let running = false;

  async function tick(): Promise<SchedulerResult> {
    if (running) {
      return {
        decisions: new Map(),
        siteAllocations: new Map(),
        pendingPlacementQueue: [],
        alerts: [],
      };
    }
    running = true;
    try {
      const rawAgents = await deps.listAgents();
      if (rawAgents.length === 0) {
        return {
          decisions: new Map(),
          siteAllocations: new Map(),
          pendingPlacementQueue: [],
          alerts: [],
        };
      }

      // Group by companyId
      const byCompany = new Map<string, ScheduledAgentCard[]>();
      for (const ag of rawAgents) {
        const list = byCompany.get(ag.companyId) ?? [];
        list.push(ag);
        byCompany.set(ag.companyId, list);
      }

      const allDecisions = new Map();
      const allAllocations = new Map();
      const allPending: string[] = [];
      const allAlerts = [];

      for (const [companyId, companyAgents] of byCompany.entries()) {
        const sites = await deps.listSites(companyId);
        const affinityRules = await deps.listAffinityRules(companyId);

        const placementInputs: AgentPlacementInput[] = [];
        const agentMap = new Map<string, ScheduledAgentCard>();

        for (const ag of companyAgents) {
          const spec = extractBotSpec(ag.adapterConfig);
          if (!spec) continue;

          agentMap.set(spec.botKey, ag);
          const container = isRecord(ag.adapterConfig.container) ? ag.adapterConfig.container : {};
          let currentHost: string | null = null;
          try {
            currentHost = cardFleetHost(ag.adapterConfig);
          } catch {
            currentHost = null;
          }
          const hostPinned = container.hostPinned === true;

          placementInputs.push({
            botKey: spec.botKey,
            agentId: ag.id,
            companyId: ag.companyId,
            projectId: ag.projectId,
            priority: ag.priority,
            currentHost,
            hostPinned,
            spec: {
              memoryMb: spec.memoryMb,
              cpus: spec.cpus,
              pidsLimit: spec.pidsLimit,
            },
            labels: isRecord(container.labels) ? (container.labels as Record<string, string>) : undefined,
          });
        }

        const result = scheduleSitePlacements(placementInputs, sites, affinityRules, {
          preemptionEnabled: deps.preemptionEnabled,
        });

        for (const [k, v] of result.decisions.entries()) allDecisions.set(k, v);
        for (const [k, v] of result.siteAllocations.entries()) allAllocations.set(k, v);
        allPending.push(...result.pendingPlacementQueue);
        allAlerts.push(...result.alerts);

        // Apply changes: if desired host != current host and bot is not pinned
        for (const decision of result.decisions.values()) {
          const agent = agentMap.get(decision.botKey);
          if (!agent) continue;
          const container = isRecord(agent.adapterConfig.container) ? { ...agent.adapterConfig.container } : {};
          if (container.hostPinned === true) continue; // never touch pinned cards

          if (decision.status === "placed" && decision.targetHost !== null) {
            const currentHost = cardFleetHost(agent.adapterConfig);
            if (currentHost !== decision.targetHost) {
              container.host = decision.targetHost;
              delete container.placementStatus;
              delete container.placementError;

              deps.log?.info(
                { botKey: decision.botKey, oldHost: currentHost, newHost: decision.targetHost, reason: decision.reason },
                "site-scheduler: reassigning bot host",
              );

              await deps.saveAdapterConfig(agent.id, {
                ...agent.adapterConfig,
                container,
              });
            }
          } else if (decision.status === "pending_placement") {
            if (container.placementStatus !== "pending_placement") {
              container.placementStatus = "pending_placement";
              container.placementError = decision.alert ?? "Waiting for site capacity";

              deps.log?.warn(
                { botKey: decision.botKey, reason: decision.reason, error: container.placementError },
                "site-scheduler: bot queued in pending placement",
              );

              await deps.saveAdapterConfig(agent.id, {
                ...agent.adapterConfig,
                container,
              });
            }
          }
        }
      }

      return {
        decisions: allDecisions,
        siteAllocations: allAllocations,
        pendingPlacementQueue: allPending,
        alerts: allAlerts,
      };
    } finally {
      running = false;
    }
  }

  const healthMonitor = createSiteHealthMonitor({
    listSites: deps.listHealthSites ?? (async () => {
      const companyIds = [...new Set((await deps.listAgents()).map((agent) => agent.companyId))];
      const sites: MonitoredSite[] = [];
      for (const companyId of companyIds) {
        for (const site of await deps.listSites(companyId)) {
          if (site.url) sites.push(site as MonitoredSite);
        }
      }
      return [...new Map(sites.map((site) => [site.name, site])).values()];
    }),
    probe: async (site) => {
      let response: Response;
      try {
        response = await fetch(`${site.url.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
      } catch {
        return "timeout";
      }
      return response.ok ? "success" : "timeout";
    },
    load: deps.loadSiteHealth ?? (async () => createSiteHealthSnapshot()),
    save: deps.saveSiteHealth ?? (async () => undefined),
    fence: deps.fenceSite ?? (async (siteName) => {
      deps.log?.warn({ siteName }, "remote site fenced after health misses");
    }),
    failover: deps.failoverSite ?? (async (siteName) => {
      deps.log?.warn({ siteName }, "remote site requires operator failover");
    }),
    log: deps.log,
  });
  const timer = laneInterval("bot_reconcile", intervalMs, () => {
    void healthMonitor.tick().catch((err) => deps.log?.error({ err }, "site health poll failed"));
    void tick().catch((err) => {
      deps.log?.error({ err }, "site-scheduler: sweep error");
    });
  });

  return {
    stop: () => { clearInterval(timer); healthMonitor.stop(); },
    tick,
  };
}
