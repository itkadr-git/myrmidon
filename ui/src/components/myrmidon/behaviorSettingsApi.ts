import type { SettingSource } from "@paperclipai/shared";
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
