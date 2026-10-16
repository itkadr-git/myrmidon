// Model fallback signal (myrmidon BOT-RUNTIME-TUNING D2, SETTINGS-UI A):
// GET/PATCH /api/myrmidon/model-fallback/settings.
//
// The five numbers behind the "this agent keeps landing on a fallback model"
// signal live in `instance_settings.general.modelFallbackSignal`. The sweep
// re-resolves them on every tick and every request — stored value, then a set
// `MYRMIDON_MODEL_FALLBACK_*` environment override, then the built-in default —
// so a change applies without a restart. The GET answer carries the per-key
// source; the panel renders exactly that.
import type {
  FallbackSignalSettingKey,
  FallbackSignalSettingSource,
  FallbackSignalSettingsPatch,
} from "@paperclipai/shared";
import { api } from "@/api/client";

/** Mirrors server ResolvedFallbackSignalSettings. */
export interface ResolvedFallbackSignalSettingsView {
  settings: {
    enabled: boolean;
    thresholdPct: number;
    minCalls: number;
    windowSec: number;
    intervalSec: number;
  };
  /** Per key: which side won — stored settings, the environment or the default. */
  sources: Record<FallbackSignalSettingKey, FallbackSignalSettingSource>;
}

export const modelFallbackSignalSettingsQueryKey = [
  "myrmidon",
  "model-fallback",
  "settings",
] as const;

export const modelFallbackSignalSettingsApi = {
  get: () =>
    api.get<ResolvedFallbackSignalSettingsView>("/myrmidon/model-fallback/settings"),
  update: (patch: FallbackSignalSettingsPatch) =>
    api.patch<ResolvedFallbackSignalSettingsView>("/myrmidon/model-fallback/settings", patch),
};

export function describeFallbackSignalSource(
  source: FallbackSignalSettingSource | undefined,
): string {
  switch (source) {
    case "settings":
      return "Saved here";
    case "env":
      return "Environment override";
    default:
      return "Default";
  }
}
