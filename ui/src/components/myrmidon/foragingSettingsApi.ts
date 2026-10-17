// Foraging settings (myrmidon 1.6.1, FORAGING-LIMITS-UI):
// GET/PATCH /api/myrmidon/foraging-settings.
//
// The enable switch, the pass tuning and the spend limits of the learning
// sweep are instance settings the server resolves on every pass. Saving here
// applies them with the next pass, without a restart. Environment variables
// stay forced per-key overrides; `sources` says per key whether the saved
// value or the override is in force, and the panel renders exactly that.
import type {
  ForagingSettings,
  ForagingSettingsPatch,
  ForagingSettingKey,
  ForagingSettingsSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export interface ForagingSettingsView {
  settings: ForagingSettings;
  sources: Record<ForagingSettingKey, ForagingSettingsSource>;
}

export const foragingSettingsQueryKey = ["myrmidon", "foraging", "settings"] as const;

export const foragingSettingsApi = {
  get: () => api.get<ForagingSettingsView>("/myrmidon/foraging-settings"),
  update: (patch: ForagingSettingsPatch) =>
    api.patch<ForagingSettingsView>("/myrmidon/foraging-settings", patch),
};

export function describeForagingSource(source: ForagingSettingsSource | undefined): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
