// myrmidon(1.6.3 PROMPT-BUDGET B): API client for the prompt-budget settings
// and the per-agent prompt status. The server part owns the routes; this
// client speaks the frozen contract:
//
//   GET /api/myrmidon/companies/:companyId/prompt-budget/settings
//         -> { warnPct, critPct, enabled, fallbackWindowTokens, optimizerAgentId }
//   PUT  /api/myrmidon/companies/:companyId/prompt-budget/settings (same body)
//   GET  /api/myrmidon/companies/:companyId/prompt-budget/status
//         -> { agents: [{ agentId, model, windowTokens, windowIsFallback,
//              lastRun: { runId, total, parts, pct, level } | null, settings }] }
import { api } from "@/api/client";

/** The stored settings row. */
export interface PromptBudgetSettings {
  warnPct: number;
  critPct: number;
  enabled: boolean;
  fallbackWindowTokens: number;
  optimizerAgentId: string | null;
}

export type PromptBudgetLevel = "ok" | "warn" | "crit";

/** One run's prompt footprint. */
export interface PromptBudgetRunStatus {
  runId: string | null;
  total: number;
  parts: Record<string, number>;
  pct: number;
  level: PromptBudgetLevel;
}

/** One agent's live prompt budget from the status endpoint. */
export interface PromptBudgetStatusEntry {
  agentId: string;
  model: string | null;
  windowTokens: number;
  windowIsFallback: boolean;
  lastRun: PromptBudgetRunStatus | null;
  settings: PromptBudgetSettings;
}

export const promptBudgetSettingsQueryKey = (companyId: string) =>
  ["myrmidon", "prompt-budget", "settings", companyId] as const;

export const promptBudgetStatusQueryKey = (companyId: string) =>
  ["myrmidon", "prompt-budget", "status", companyId] as const;

const settingsPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/prompt-budget/settings`;
const statusPath = (companyId: string) =>
  `/myrmidon/companies/${encodeURIComponent(companyId)}/prompt-budget/status`;

export const promptBudgetApi = {
  getSettings: (companyId: string) => api.get<PromptBudgetSettings>(settingsPath(companyId)),
  putSettings: (companyId: string, settings: PromptBudgetSettings) =>
    api.put<PromptBudgetSettings>(settingsPath(companyId), settings),
  getStatus: (companyId: string) =>
    api.get<{ agents: PromptBudgetStatusEntry[] }>(statusPath(companyId)),
};
