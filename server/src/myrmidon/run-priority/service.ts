// Live run queue priority settings (myrmidon 1.6.5, RUN-PRIORITY A).
//
// Same contract as the run admission limits (`../runtime-limits/service.ts`):
// `instance_settings.general.runPriority` is the source of truth once an
// operator saves it; the environment stays the default for an instance that
// never did. A change writes the row, records it in the activity log, applies
// it to the process-wide in-force settings and asks the queued-run sweep to
// run, so new weights reach the queue without a restart. Both sweeps read the
// in-force settings fresh on every pass (`currentRunPrioritySettings`).

import type { Db } from "@paperclipai/db";
import {
  mergeRunPrioritySettings,
  type RunPriorityPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { applyRunPrioritySettings, resolveRunPriority, type RunPriorityView } from "./state.js";
import type { RunPrioritySettings } from "@paperclipai/shared";

/** Who changed the settings, for the activity log. */
export interface RunPriorityActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type RunPriorityAuditEntry = RunPriorityActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface RunPriorityServiceDeps {
  settings: {
    getGeneral(): Promise<{ runPriority?: unknown }>;
    updateGeneral(patch: { runPriority: RunPrioritySettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: RunPriorityAuditEntry): Promise<unknown>;
  /** Put the settings in force for the live sweeps. */
  apply(settings: RunPrioritySettings): void;
  /** Ask the queued-run sweep to run shortly, so held runs reorder at once. */
  scheduleResweep(): void;
  env?: Record<string, string | undefined>;
}

export interface RunPriorityService {
  read(): Promise<RunPriorityView>;
  /** Persist, audit and apply a patch; returns the settings now in force. */
  update(patch: RunPriorityPatch, actor: RunPriorityActor): Promise<RunPriorityView>;
}

/** `instance.run_priority.updated` — the audit action of a settings change. */
export const RUN_PRIORITY_ACTION = "instance.run_priority.updated";

let runPriorityTransitionQueue: Promise<void> = Promise.resolve();

/** Serialize read-write-audit-apply like the runtime-limits transition does. */
function withRunPriorityTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = runPriorityTransitionQueue.then(run);
  runPriorityTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function runPriorityService(
  db: Db,
  overrides: Partial<RunPriorityServiceDeps> = {},
): RunPriorityService {
  const deps: RunPriorityServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: applyRunPrioritySettings,
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async () => {
      const general = await deps.settings.getGeneral();
      return resolveRunPriority(general.runPriority, env);
    },

    update: async (patch, actor) =>
      withRunPriorityTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveRunPriority(general.runPriority, env).settings;
        const next = mergeRunPrioritySettings(before, patch);

        await deps.settings.updateGeneral({ runPriority: next });

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
              action: RUN_PRIORITY_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before, next },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the
        // settings in force must never run ahead of what the log says.
        deps.apply(next);
        deps.scheduleResweep();
        logger.info(
          { settings: next, actorType: actor.actorType },
          "run queue priority settings updated without a restart",
        );
        return { settings: next, source: "settings" as const };
      }),
  };
}
