import type { SettingSource } from "@myrmidon/shared";
import { api } from "@/api/client";

export type BehaviorSettingValue = string | number | boolean | null | unknown[] | Record<string, unknown>;
export interface BehaviorSettingsView {
  settings: Record<string, BehaviorSettingValue>;
  sources: Record<string, SettingSource>;
}
export const behaviorSettingsQueryKey = ["myrmidon", "behavior-settings"] as const;
export const behaviorSettingsApi = {
  get: () => api.get<BehaviorSettingsView>("/myrmidon/behavior-settings"),
  update: (patch: Record<string, BehaviorSettingValue>) => api.patch<BehaviorSettingsView>("/myrmidon/behavior-settings", patch),
};

/** The display text of a setting's source, with the caller's translated labels. */
export function sourceLabel(source: SettingSource | undefined, labels: { env: string; ui: string; default: string }): string {
  return source === "env" ? labels.env : source === "ui" ? labels.ui : labels.default;
}
