import { api } from "./client";

export interface FleetHost { name: string; origin: "victoriametrics" | "zabbix" | "none"; cpuPercent: number | null; memoryPercent: number | null; diskPercent: number | null; ageSec: number | null; }
export interface FleetContainer { name: string; state: "running" | "stopped" | "unknown"; cpuPercent: number | null; memoryBytes: number | null; }
export interface FleetDashboard { ok: boolean; generatedAt: string; sources: Array<{ name: string; ok: boolean; latency_ms: number | null; error: string | null }>; hosts: FleetHost[]; containers: FleetContainer[]; }

export type FleetSiteState = "unknown" | "healthy" | "degraded" | "unreachable" | "draining" | "quarantined";
export interface FleetSiteBadge { name: string; state: FleetSiteState; status: string; autoDrained: boolean; lastSeenAt: string | null; }

export const fleetApi = {
  sites: (companyId: string) => api.get<{ sites: FleetSiteBadge[] }>(`/myrmidon/fleet/sites?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" }),
  dashboard: (companyId: string) => api.get<FleetDashboard>(`/myrmidon/monitoring/dashboard?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" }),
};