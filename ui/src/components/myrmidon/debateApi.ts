// Asymmetric debates (myrmidon 1.7 DEBATE-ASYM A):
// GET/PATCH /api/myrmidon/debate/settings.
//
// The role configuration of the debate engine — generator/critic/judge models
// (the server refuses a symmetric configuration with the exact reason), the
// round count (max 3) and the token ceiling. PATCH saves
// `instance_settings.general.debate`; the next debate run already uses it —
// no server restart. GET also reports the source of the effective value.
import type { DebateSettings } from "@paperclipai/shared";
import { api } from "@/api/client";

export interface DebateGatewayView {
  configured: boolean;
  problem: string | null;
}

export interface DebateSettingsView {
  settings: DebateSettings | null;
  source: "settings" | "env" | "default" | null;
  problem: string | null;
  gateway: DebateGatewayView;
}

export const debateSettingsQueryKey = ["myrmidon", "debate-settings"] as const;

/**
 * One caste's debate configuration (1.7-DEBATE-ASYM-B). The values are the
 * effective ones — the caste entry over the instance configuration — and every
 * source is reported, so the screen can say what a caste inherits and what it
 * overrides.
 */
export interface CasteDebateSettingsView {
  casteKey: string;
  enabled: boolean;
  enabledSource: "caste" | "default";
  settings: DebateSettings | null;
  source: "caste" | "settings" | "env" | "default" | null;
  instanceSource: "settings" | "env" | "default" | null;
  overrides: string[];
  prompts: Partial<Record<"generator" | "critic" | "judge", string>>;
  problem: string | null;
  /** The stored entry; null = the caste inherits the instance configuration. */
  stored: DebateCastePatch | null;
  summary: string;
  gateway: DebateGatewayView;
}

/** The knobs a caste may override (the PATCH body / the stored entry). */
export interface DebateCastePatch {
  enabled?: boolean;
  generator?: DebateSettings["generator"];
  critic?: DebateSettings["critic"];
  judge?: DebateSettings["judge"];
  rounds?: number;
  tokenCeiling?: number;
  prompts?: Partial<Record<"generator" | "critic" | "judge", string>>;
}

/** What a run answers: the task document plus the outcome summary. */
export interface DebateRunView {
  issueId: string;
  casteKey: string | null;
  documentKey: string;
  costRecorded: boolean;
  outcome: {
    completed: boolean;
    stopReason: string | null;
    stopDetail: string;
    roundsRun: number;
    roundsPlanned: number;
    tokensUsed: number;
    tokenCeiling: number;
    judgeVerdict: string | null;
    casteKey?: string | null;
    customPrompts?: string[];
    roles: Record<"generator" | "critic" | "judge", { model: string; family: string }>;
    cost: { totalCents: number };
  };
}

export const casteDebateQueryKey = (companyId: string, casteKey: string) =>
  ["myrmidon", "debate-caste", companyId, casteKey] as const;

export const debateApi = {
  get: () => api.get<DebateSettingsView>("/myrmidon/debate/settings"),
  update: (settings: DebateSettings | null) =>
    api.patch<DebateSettingsView>("/myrmidon/debate/settings", { settings }),
  casteGet: (companyId: string, casteKey: string) =>
    api.get<CasteDebateSettingsView>(
      `/myrmidon/companies/${companyId}/debates/castes/${encodeURIComponent(casteKey)}/settings`,
    ),
  casteUpdate: (companyId: string, casteKey: string, settings: DebateCastePatch | null) =>
    api.patch<CasteDebateSettingsView>(
      `/myrmidon/companies/${companyId}/debates/castes/${encodeURIComponent(casteKey)}/settings`,
      { settings },
    ),
  /** Run one debate for a task; `casteKey` is the caste of the row it runs from. */
  run: (companyId: string, issueId: string, body: { casteKey?: string; question?: string } = {}) =>
    api.post<DebateRunView>(`/myrmidon/companies/${companyId}/debates/issues/${issueId}/run`, body),
};

export function describeDebateSource(source: DebateSettingsView["source"]): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Forced by the server environment (MYRMIDON_DEBATE_CONFIG)";
    case "default":
      return "Built-in default (free models, different families)";
    default:
      return "No usable configuration";
  }
}

/** The caption for a caste: what it inherits, what it overrides. */
export function describeCasteDebateSource(
  source: CasteDebateSettingsView["source"],
  instanceSource: CasteDebateSettingsView["instanceSource"],
): string {
  if (source === "caste") return "Set for this caste";
  return `Inherited from the instance level (${describeDebateSource(instanceSource)})`;
}

/** The line under the switch: where the on/off value comes from. */
export function describeCasteEnabledSource(source: CasteDebateSettingsView["enabledSource"]): string {
  return source === "caste" ? "Set for this caste" : "On by default — no per-caste switch saved yet";
}
