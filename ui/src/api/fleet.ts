import { api } from "./client";
import type { EnrollBody } from "../lib/remoteSites";

export interface FleetHost { name: string; origin: "victoriametrics" | "zabbix" | "none"; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null; ageSec: number | null; }
export interface FleetContainer { name: string; state: "running" | "stopped" | "unknown"; cpuPercent: number | null; memoryBytes: number | null; }
export interface FleetDashboard { ok: boolean; generatedAt: string; sources: Array<{ name: string; ok: boolean; latency_ms: number | null; error: string | null }>; hosts: FleetHost[]; containers: FleetContainer[]; }

export type FleetSiteState = "unknown" | "healthy" | "degraded" | "unreachable" | "draining" | "quarantined";
export interface FleetSiteBadge { name: string; state: FleetSiteState; status: string; autoDrained: boolean; lastSeenAt: string | null; }

/** One site on the fleet screen (GET /myrmidon/fleet/sites/overview): the badge plus capacity, bots, drift and the key TTL. */
export interface FleetSiteOverview extends FleetSiteBadge {
  url: string;
  labels: Record<string, string>;
  clientCertNotAfter: string | null;
  certExpired: boolean;
  capacity: {
    cpus: { used: number; total: number };
    memoryMb: { used: number; total: number };
    bots: { used: number; total: number | null };
  };
  botCount: number;
  driftCount: number | null;
  enrolledAt: string;
}

export interface FleetSiteBot {
  botKey: string;
  agentName: string;
  state: string;
  image: string | null;
  drift: boolean;
  driftFields: string[];
  apiBaseUrl: string | null;
  gatewayPort: number | null;
  pinned: boolean;
}

const q = encodeURIComponent;

export const fleetApi = {
  sites: (companyId: string) => api.get<{ sites: FleetSiteBadge[] }>(`/myrmidon/fleet/sites?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" }),
  dashboard: (companyId: string) => api.get<FleetDashboard>(`/myrmidon/monitoring/dashboard?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" }),
  sitesOverview: (companyId: string) => api.get<{ sites: FleetSiteOverview[] }>(`/myrmidon/fleet/sites/overview?companyId=${q(companyId)}`, { cache: "no-store" }),
  siteBots: (companyId: string, site: string) => api.get<{ site: string; bots: FleetSiteBot[] }>(`/myrmidon/fleet/sites/${q(site)}/bots?companyId=${q(companyId)}`, { cache: "no-store" }),
  drainSite: (companyId: string, site: string) => api.post<{ status: string; changed: boolean }>(`/myrmidon/fleet/sites/${q(site)}/drain?companyId=${q(companyId)}`, {}),
  resumeSite: (companyId: string, site: string) => api.post<{ status: string; changed: boolean }>(`/myrmidon/fleet/sites/${q(site)}/resume?companyId=${q(companyId)}`, {}),
  restartBot: (botKey: string) => api.post<{ ok: boolean }>(`/myrmidon/fleet/bots/${q(botKey)}/restart`, {}),
  stopBot: (botKey: string) => api.post<{ ok: boolean }>(`/myrmidon/fleet/bots/${q(botKey)}/stop`, {}),
  moveBot: (botKey: string, to: string) => api.post<{ move: { phase: string } }>(`/myrmidon/fleet/bots/${q(botKey)}/move`, { to }),
  botLogs: (botKey: string, tail = 100) => api.get<{ logs: string }>(`/myrmidon/fleet/bots/${q(botKey)}/logs?tail=${tail}`, { cache: "no-store" }),
  enrollSite: (companyId: string, body: EnrollBody) => api.post<{ site: { name: string } }>(`/companies/${q(companyId)}/fleet/sites`, body),
};
