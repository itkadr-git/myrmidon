// Processes of the board (myrmidon PROCS-1.1): the route and the startup read
// of `instance_settings.general.processes` (design OPE-5394 §7.2).
import type { Db } from "@paperclipai/db";
import { applyProcessesSettingsToProcess, createProcessesSettingsService, defaultProcessesSettingsDeps } from "./service.js";
import { myrmidonProcessesRoutes } from "./routes.js";

export {
  createProcessesSettingsService,
  PROCESSES_SETTINGS_ACTION,
  type ProcessesSettingsDeps,
  type ProcessesSettingsService,
  type ProcessesSettingsView,
} from "./service.js";
export { myrmidonProcessesRoutes } from "./routes.js";

/** The router of the process settings, with the production dependencies. */
export function myrmidonProcessesRouter(db: Db) {
  return myrmidonProcessesRoutes(db, createProcessesSettingsService(defaultProcessesSettingsDeps(db)));
}

/**
 * Reads the stored settings at startup and records the mode in force before
 * the process starts serving. A stored `split` is reported as not in effect
 * (this build has no supervisor yet), never applied half-way.
 */
export async function startProcessesSettings(db: Db): Promise<void> {
  const service = createProcessesSettingsService(defaultProcessesSettingsDeps(db));
  const view = await service.read();
  applyProcessesSettingsToProcess(view.settings);
}