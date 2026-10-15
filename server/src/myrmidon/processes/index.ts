// Processes of the board (myrmidon PROCS-1.1/1.2): the route, the startup read
// of `instance_settings.general.processes` (design OPE-5394 §7.2), and the
// supervisor wiring (§7.1).
import type { Db } from "@paperclipai/db";
import { applyProcessesSettingsToProcess, createProcessesSettingsService, defaultProcessesSettingsDeps } from "./service.js";
import { myrmidonProcessesRoutes } from "./routes.js";
import type { ProcessSupervisor } from "./supervisor.js";

export {
  createProcessesSettingsService,
  PROCESSES_SETTINGS_ACTION,
  type ProcessesSettingsDeps,
  type ProcessesSettingsService,
  type ProcessesSettingsView,
} from "./service.js";
export { myrmidonProcessesRoutes } from "./routes.js";
export {
  createProcessSupervisor,
  PARENT_BOOT_ID_ENV,
  SUPERVISOR_IPC_DRAIN,
  SUPERVISOR_IPC_READY,
  SUPERVISOR_BACKOFF_INITIAL_MS,
  SUPERVISOR_BACKOFF_MAX_MS,
  SUPERVISOR_DRAIN_GRACE_MS,
  SUPERVISOR_NO_CHILD_GRACE_MS,
  type ProcessSupervisor,
  type ProcessSupervisorDeps,
  type SupervisorListenerHandle,
  type SupervisorState,
} from "./supervisor.js";
export { isSupervisedChild, reportReadyToSupervisor, wireSupervisorDrainHandler } from "./child.js";

/** The router of the process settings, with the production dependencies. */
export function myrmidonProcessesRouter(db: Db, supervisor: ProcessSupervisor | null = null) {
  return myrmidonProcessesRoutes(db, createProcessesSettingsService(defaultProcessesSettingsDeps(db, supervisor)));
}

/**
 * Reads the stored settings at startup and applies the mode in force: with a
 * wired supervisor (worker role) a stored `split` forks the api children right
 * away; without one the call only records and reports. The emergency escape
 * PAPERCLIP_PROCESS_MODE=single wins over the stored row before this runs.
 */
export async function startProcessesSettings(db: Db, supervisor: ProcessSupervisor | null = null): Promise<void> {
  const service = createProcessesSettingsService(defaultProcessesSettingsDeps(db, supervisor));
  const view = await service.read();
  applyProcessesSettingsToProcess(view.settings, [], supervisor);
}
