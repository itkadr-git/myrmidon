// Forgotten-pause guard settings (myrmidon 1.6.5 PAUSE-GUARD):
// GET/PATCH /api/myrmidon/pause-guard.
//
// The guard resumes agents the operator paused and left paused longer than the
// threshold. PATCH saves the values to the instance settings; the guard reads
// them at its next pass, so a change takes effect without restarting the
// server.
import type {
  PauseGuardSettingKey,
  PauseGuardSettings,
  PauseGuardSettingsPatch,
  PauseGuardSettingsSource,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export interface PauseGuardView {
  settings: PauseGuardSettings;
  sources: Record<PauseGuardSettingKey, PauseGuardSettingsSource>;
}

export const pauseGuardQueryKey = ["myrmidon", "pause-guard"] as const;

export const pauseGuardApi = {
  get: () => api.get<PauseGuardView>("/myrmidon/pause-guard"),
  update: (patch: PauseGuardSettingsPatch) => api.patch<PauseGuardView>("/myrmidon/pause-guard", patch),
};

export function describePauseGuardSource(source: PauseGuardSettingsSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}

/** The allowlist as one editable line: names separated by commas. */
export function formatAllowlist(allowlist: readonly string[]): string {
  return allowlist.join(", ");
}

/**
 * A comma- or newline-separated list of agent names, parsed for the API body.
 * Entries are trimmed and duplicates dropped, so a pasted list with blank
 * lines stores cleanly.
 */
export function parseAllowlistDraft(draft: string): string[] {
  return draft
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry, index, all) => all.findIndex((other) => other.toLowerCase() === entry.toLowerCase()) === index);
}