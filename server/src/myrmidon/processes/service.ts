// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2): read and
// write `instance_settings.general.processes`.
//
// The read reports each value with its source (the saved row, the environment
// or the default) and says which mode the build actually honours.
//
// The write goes the same way the other instance settings do: store the row,
// write one activity record per company, and only then apply the value to the
// running process, so the settings in force never run ahead of the journal.
// Values are applied without a restart: PROCS-1.2 routes them into the
// process supervisor, which forks or drains the api children and moves the
// worker's own listener between single and split.
import type { Db } from "@paperclipai/db";
import {
  describeProcessesEffect,
  mergeProcessesSettings,
  PROCESSES_MODE_ENV,
  PROCESSES_SETTING_KEYS,
  resolveProcessesSettings,
  type ProcessesMode,
  type ProcessesSettingKey,
  type ProcessesSettingSource,
  type ProcessesSettings,
  type ProcessesSettingsPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import type { getActorInfo } from "../../routes/authz.js";
import type { ProcessSupervisor } from "./supervisor.js";

/** The action written to the activity journal on every change. */
export const PROCESSES_SETTINGS_ACTION = "instance.processes.updated";

/** What the settings page reads: the values, their sources, and what is in force. */
export interface ProcessesSettingsView {
  settings: ProcessesSettings;
  sources: Record<ProcessesSettingKey, ProcessesSettingSource>;
  /** The mode this build honours, which is `single` while the supervisor is missing. */
  effectiveMode: ProcessesMode;
  /** Why the honoured mode differs from the saved one, or null when they agree. */
  notInEffectReason: string | null;
}

export type ProcessesActor = ReturnType<typeof getActorInfo>;

export interface ProcessesSettingsDeps {
  // Structural on purpose: instanceSettingsService() returns the full service
  // shape and the general settings row carries every settings key, not just
  // `processes`. A narrower structural contract keeps the service testable
  // without fighting the widening upstream types.
  settings: {
    getGeneral(): Promise<{ processes?: unknown }>;
    updateGeneral(patch: { processes: ProcessesSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
  /**
   * Puts the new values into the running process. PROCS-1.1 has nowhere else
   * to put them yet, so the default implementation records them and warns when
   * a mode was stored that this build cannot run.
   */
  apply(settings: ProcessesSettings, changedKeys: ProcessesSettingKey[]): void;
  env?: Record<string, string | undefined>;
}

export interface ProcessesSettingsService {
  read(): Promise<ProcessesSettingsView>;
  update(patch: ProcessesSettingsPatch, actor: ProcessesActor): Promise<ProcessesSettingsView>;
}

/**
 * One write at a time, in this process. Two operators saving at once would
 * otherwise read the same `before`, and the second write would drop the first
 * one's keys; the cross-process lock (`FOR UPDATE`) arrives with the shared
 * settings registry of the next part.
 */
let processesTransition: Promise<unknown> = Promise.resolve();

function withProcessesTransition<T>(task: () => Promise<T>): Promise<T> {
  const run = processesTransition.then(task, task);
  processesTransition = run.catch(() => undefined);
  return run;
}

export function createProcessesSettingsService(deps: ProcessesSettingsDeps): ProcessesSettingsService {
  const env = deps.env ?? process.env;

  function view(stored: unknown): ProcessesSettingsView {
    const resolved = resolveProcessesSettings(stored, env);
    return { ...resolved, ...describeProcessesEffect(resolved.settings) };
  }

  return {
    read: async (): Promise<ProcessesSettingsView> => {
      const general = await deps.settings.getGeneral();
      return view(general.processes);
    },

    update: async (patch, actor) =>
      withProcessesTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveProcessesSettings(general.processes, env);
        const next = mergeProcessesSettings(before.settings, patch);
        const changedKeys = PROCESSES_SETTING_KEYS.filter(
          (key) => before.settings[key] !== next[key],
        ) as ProcessesSettingKey[];

        await deps.settings.updateGeneral({ processes: next });

        const companyIds = await deps.listCompanyIds();
        await Promise.all(
          companyIds.map((companyId) =>
            deps.logActivity({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: PROCESSES_SETTINGS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the journal records are committed.
        deps.apply(next, changedKeys);
        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "process settings updated without a restart",
        );
        return view(next);
      }),
  };
}

/**
 * The apply step of a live board: record what is in force and say out loud
 * when the saved mode is one this build cannot run, so the reason reaches the
 * server journal instead of only the settings page. When a supervisor is
 * wired (PROCS-1.2) the mode/apiCount change also drives it: children fork or
 * drain, and the worker's own listener moves between single and split.
 */
export function applyProcessesSettingsToProcess(
  settings: ProcessesSettings,
  changedKeys: ProcessesSettingKey[] = [],
  supervisor: ProcessSupervisor | null = null,
): void {
  const { effectiveMode, notInEffectReason } = describeProcessesEffect(settings);
  if (notInEffectReason) {
    logger.warn(
      {
        mode: settings.mode,
        effectiveMode,
        apiCount: settings.apiCount,
        changedKeys,
        escape: PROCESSES_MODE_ENV,
      },
      notInEffectReason,
    );
    return;
  }
  logger.info(
    {
      mode: settings.mode,
      apiCount: settings.apiCount,
      liveEventsBus: settings.liveEventsBus,
      admissionStore: settings.admissionStore,
      changedKeys,
    },
    "process settings in force",
  );
  if (supervisor && (changedKeys.includes("mode") || changedKeys.includes("apiCount") || changedKeys.length === 0)) {
    void supervisor.apply(settings).catch((err) => {
      logger.error({ err, mode: settings.mode, apiCount: settings.apiCount }, "myrmidon(PROCS-1.2): supervisor apply failed");
    });
  }
}

/** Production dependencies: the instance settings, the journal, and this process. */
export function defaultProcessesSettingsDeps(db: Db, supervisor: ProcessSupervisor | null = null): ProcessesSettingsDeps {
  const settings = instanceSettingsService(db);
  return {
    // The service narrows the full instance-settings shape to just the
    // `processes` key; both directions are type-compatible, the casts keep the
    // ProcessesSettingsDeps contract structural (see above).
    settings: {
      getGeneral: () => settings.getGeneral(),
      updateGeneral: (patch) => settings.updateGeneral(patch),
    },
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: (settings, changedKeys) => applyProcessesSettingsToProcess(settings, changedKeys, supervisor),
    env: process.env,
  };
}