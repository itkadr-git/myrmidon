// myrmidon(PROCS-1.8): committed-settings invalidation registry.
import type { Db } from "@paperclipai/db";
import { startRuntimeLimits } from "../runtime-limits/index.js";
import { resetMaintenanceGateCaches } from "../maintenance/gate.js";
import { MAINTENANCE_GENERAL_KEY } from "../maintenance/store.js";
import { startProcessesSettings } from "../processes/index.js";
import type { ProcessSupervisor } from "../processes/supervisor.js";

export const SETTINGS_CHANGED_KEYS = ["runLimits", "teamLiveness", "myrmidonMaintenance", "processes"] as const;
export interface SettingsChangedPayload { changedKeys?: string[] }
export interface SettingsApplierDeps {
  db: Db;
  processSupervisor?: ProcessSupervisor | null;
  applyTeamLiveness?: () => Promise<void>;
}

/** Notifications carry invalidation keys only; state always comes from the DB. */
export async function applySettingsChanged(payload: SettingsChangedPayload, deps: SettingsApplierDeps): Promise<void> {
  const keys = new Set(payload.changedKeys ?? []);
  if (keys.has("runLimits")) await startRuntimeLimits(deps.db);
  if (keys.has("teamLiveness")) await deps.applyTeamLiveness?.();
  if (keys.has(MAINTENANCE_GENERAL_KEY)) resetMaintenanceGateCaches();
  if (keys.has("processes")) await startProcessesSettings(deps.db, deps.processSupervisor ?? null);
}

export function registerSettingsAppliers(
  bus: { subscribe<T>(channel: "settings_changed", handler: (payload: T) => void): () => void },
  deps: SettingsApplierDeps,
): () => void {
  return bus.subscribe<SettingsChangedPayload>("settings_changed", (payload) => {
    void applySettingsChanged(payload ?? {}, deps).catch(() => {
      // Timer-driven settings readers remain the fallback if local application fails.
    });
  });
}
