// myrmidon(TRACING-HEALTH): API client for the "LLM tracing" status card.
// Server side: server/src/myrmidon/tracing-health/routes.ts
// GET /api/myrmidon/companies/:companyId/tracing/health

import { api } from "@/api/client";

export type TracingHealthStatus = "ok" | "red";

export interface TracingHealthCard {
  status: TracingHealthStatus;
  checks: {
    gatewayTraffic: { ok: boolean; note: string };
    eventsCore: { ok: boolean; note: string; count: number | null };
    callbackErrors: { ok: boolean; note: string; failures: number | null };
  };
  summary: string;
  enabled: boolean;
  windowMs: number;
  checkedAt: string;
}

export const tracingHealthKey = (companyId: string) =>
  ["myrmidon", "tracing", "health", companyId] as const;

export const tracingHealthApi = {
  get: (companyId: string) =>
    api.get<TracingHealthCard>(`/myrmidon/companies/${encodeURIComponent(companyId)}/tracing/health`),
};

/** "15 min" style window label, or null for unknown. */
export function formatWindowLabel(windowMs: number): string {
  const minutes = Math.round(windowMs / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}
