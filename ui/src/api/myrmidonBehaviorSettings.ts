// Behavior settings API (ui/src/api/myrmidonBehaviorSettings.ts)
//
// myrmidon(1.7 SETTINGS-TO-UI): thin typed wrappers over
// GET /api/myrmidon/behavior-settings — the resolved view (value + source per
// key) and GET /api/myrmidon/behavior-settings/definitions — the registry
// metadata (env name, section, default). Used by the read-only SWEEP-2 block
// (OPE-12046) and the existing settings panels.
import { api } from "@/api/client";
import type { SettingSource } from "@myrmidon/shared";

export type BehaviorSettingValue = string | number | boolean | null | unknown[] | Record<string, unknown>;

export interface BehaviorSettingsView {
  settings: Record<string, BehaviorSettingValue>;
  sources: Record<string, SettingSource>;
}

export interface BehaviorSettingDefinition {
  key: string;
  envName: string;
  default: unknown;
  scope: "instance" | "company";
  section: string;
  valueType: "boolean" | "string" | "number" | "json";
  description?: string | null;
}

export const behaviorSettingsQueryKey = ["myrmidon", "behavior-settings"] as const;

export const behaviorSettingsApi = {
  get: () => api.get<BehaviorSettingsView>("/myrmidon/behavior-settings"),
  getDefinitions: () =>
    api.get<BehaviorSettingDefinition[]>("/myrmidon/behavior-settings/definitions"),
  update: (patch: Record<string, BehaviorSettingValue>) =>
    api.patch<BehaviorSettingsView>("/myrmidon/behavior-settings", patch),
};

export const getBehaviorSettings = behaviorSettingsApi.get;
export const getBehaviorSettingsDefinitions = behaviorSettingsApi.getDefinitions;

/** The display text of a setting's source, with the caller's translated labels. */
export function sourceLabel(
  source: SettingSource | undefined,
  labels: { env: string; ui: string; default: string },
): string {
  return source === "env" ? labels.env : source === "ui" ? labels.ui : labels.default;
}
