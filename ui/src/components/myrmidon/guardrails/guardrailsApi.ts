// myrmidon(1.7-GRD-MODES): API client for the "Guardrails" settings screen
// and the firing journal. Speaks the server routes of OPE-4167:
//
//   GET /api/myrmidon/companies/:companyId/guardrails/settings -> GuardrailModesSettings
//   PUT /api/myrmidon/companies/:companyId/guardrails/settings (board)
//   GET /api/myrmidon/companies/:companyId/guardrails/resolve?agentId= -> per-agent effective modes
//   GET /api/myrmidon/companies/:companyId/guardrails/events?limit&kind&severity&surface&runId
//
// Types import from @paperclipai/shared — the same contract the server
// validates and stores, so a drift fails typecheck on both sides.
import { api } from "@/api/client";
import type {
  GuardrailModesSettings,
  GuardrailRule,
  ResolvedGuardrailMode,
} from "@paperclipai/shared";

export const guardrailsSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "guardrails", "settings", companyId] as const;

export const guardrailsEventsQueryKey = (companyId: string, filters: GuardrailEventFilters) =>
  ["myrmidon", "guardrails", "events", companyId, filters] as const;

const base = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/guardrails`;

export interface GuardrailEventFilters {
  kind?: string;
  severity?: string;
  surface?: string;
  runId?: string;
  limit?: number;
}

export interface GuardrailEventRow {
  id: string;
  companyId: string;
  kind: string;
  surface: string;
  severity: string;
  runId: string | null;
  issueId: string | null;
  snippet: string | null;
  occurredAt: string;
}

export const guardrailsApi = {
  getSettings: (companyId: string) =>
    api.get<GuardrailModesSettings>(`${base(companyId)}/settings`),
  putSettings: (companyId: string, settings: GuardrailModesSettings) =>
    api.put<GuardrailModesSettings>(`${base(companyId)}/settings`, settings),
  resolveForAgent: (companyId: string, agentId: string) =>
    api.get<{ agentRole: string | null; forced: string | null; rules: ResolvedGuardrailMode[] }>(
      `${base(companyId)}/resolve?agentId=${encodeURIComponent(agentId)}`,
    ),
  listEvents: (companyId: string, filters: GuardrailEventFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.kind) params.set("kind", filters.kind);
    if (filters.severity) params.set("severity", filters.severity);
    if (filters.surface) params.set("surface", filters.surface);
    if (filters.runId) params.set("runId", filters.runId);
    if (filters.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<{ events: GuardrailEventRow[]; count: number; limit: number }>(
      `${base(companyId)}/events${qs ? `?${qs}` : ""}`,
    );
  },
};
