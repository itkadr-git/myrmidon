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

export const debateApi = {
  get: () => api.get<DebateSettingsView>("/myrmidon/debate/settings"),
  update: (settings: DebateSettings | null) =>
    api.patch<DebateSettingsView>("/myrmidon/debate/settings", { settings }),
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
