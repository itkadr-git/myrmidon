// Service-model behavior settings (myrmidon 1.7 SETTINGS-TO-UI D, "Models"
// section): GET/PATCH /api/myrmidon/behavior-settings. Per key the server
// answers with the value in force and where it came from (the saved value,
// the environment override, the built-in default).
import { api } from "@/api/client";

export type ModelServiceSettingSource = "ui" | "env" | "default";

export interface ModelServiceSettingsView {
  settings: Record<string, unknown>;
  sources: Record<string, ModelServiceSettingSource>;
}

export type ModelServiceSettingsPatch = Record<string, string | number | boolean | Record<string, number>>;

export const modelServiceSettingsQueryKey = ["myrmidon", "behavior-settings"] as const;

export const modelServiceSettingsApi = {
  get: () => api.get<ModelServiceSettingsView>("/myrmidon/behavior-settings"),
  update: (patch: ModelServiceSettingsPatch) =>
    api.patch<ModelServiceSettingsView>("/myrmidon/behavior-settings", patch),
};

export function describeModelServiceSettingSource(source: ModelServiceSettingSource | undefined): string {
  if (source === "ui") return "Saved here";
  if (source === "env") return "Environment override";
  return "Default";
}
