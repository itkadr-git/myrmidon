// Process-wide live behavior settings (myrmidon 1.7, SETTINGS-TO-UI A).
//
// The values an operator saved and that the running server is honoring right
// now, without a restart. Parts B–E read their keys from here; startup calls
// `applyLiveBehaviorSettings` once so a reboot keeps the stored values in
// force (the same contract runtime-limits follows with applyRunAdmissionLimits).

import {
  behaviorSettingRegistry,
  type ResolvedBehaviorSettings,
} from "@paperclipai/shared";

let liveSettings: Record<string, unknown> = {};
let liveSources: Record<string, string> = {};

/** The value in force for one registered key (or its built-in default). */
export function liveBehaviorSetting<T = unknown>(key: string): T {
  if (key in liveSettings) return liveSettings[key] as T;
  const def = behaviorSettingRegistry.get(key);
  return (def?.default ?? undefined) as T;
}

export function liveBehaviorSettingsView(): ResolvedBehaviorSettings {
  return { settings: { ...liveSettings }, sources: { ...liveSources } as ResolvedBehaviorSettings["sources"] };
}

/** Put a resolved settings view in force for the running process. */
export function applyLiveBehaviorSettings(view: ResolvedBehaviorSettings): void {
  liveSettings = { ...view.settings };
  liveSources = { ...view.sources };
}
