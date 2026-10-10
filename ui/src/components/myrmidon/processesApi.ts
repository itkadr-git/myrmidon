// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2):
// GET/PATCH /api/myrmidon/processes from the settings page.
//
// The board runs as one process today (`single`). The setting says how the
// processes are meant to be arranged once the supervisor of the next part of
// the feature lands; until then a saved `split` is stored and reported as not
// in effect, and the panel says so instead of showing a mode nothing runs.
import type {
  ProcessesMode,
  ProcessesSettingKey,
  ProcessesSettingSource,
  ProcessesSettings,
  ProcessesSettingsPatch,
} from "@paperclipai/shared";
import { api } from "@/api/client";

export interface ProcessesSettingsView {
  settings: ProcessesSettings;
  sources: Record<ProcessesSettingKey, ProcessesSettingSource>;
  /** What this build honours; `single` while the supervisor is missing. */
  effectiveMode: ProcessesMode;
  /** Why it differs from the saved mode, or null when they agree. */
  notInEffectReason: string | null;
}

export const processesQueryKey = ["myrmidon", "processes"] as const;

export const processesApi = {
  get: () => api.get<ProcessesSettingsView>("/myrmidon/processes"),
  update: (patch: ProcessesSettingsPatch) => api.patch<ProcessesSettingsView>("/myrmidon/processes", patch),
};

export function describeProcessesSource(source: ProcessesSettingSource): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "From the server environment";
    default:
      return "Default";
  }
}

/** The mode label the panel shows in the picker. */
export function describeProcessesMode(mode: ProcessesMode): string {
  return mode === "split" ? "Split (worker and api processes)" : "Single (one process does everything)";
}

/**
 * One line for the settings page: what the saved mode means, and — when this
 * build cannot run it yet — that the board is still one process. `null` when
 * the saved mode is the mode in force, so the panel stays quiet when there is
 * nothing to explain.
 */
export function describeProcessesEffectNotice(
  view: Pick<ProcessesSettingsView, "settings" | "effectiveMode" | "notInEffectReason">,
): string | null {
  if (!view.notInEffectReason) return null;
  return `Saved mode "${view.settings.mode}" is not in effect: the board runs as "${view.effectiveMode}". ${view.notInEffectReason}.`;
}