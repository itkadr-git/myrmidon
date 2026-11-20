// Live run queue priority settings (myrmidon 1.6.5, RUN-PRIORITY A).
//
// Same contract as the run admission limits (`../runtime-limits/service.ts`):
// `instance_settings.general.runPriority` is the source of truth once an
// operator saves it; the environment stays the default for an instance that
// never did. A change writes the row, records it in the activity log, applies
// it to the process-wide in-force settings and asks the queued-run sweep to
// run, so new weights reach the queue without a restart. Both sweeps read the
// in-force settings fresh on every pass (`currentRunPrioritySettings`).

import type { Db } from "@myrmidon/db";
import {
  mergeRunPrioritySettings,
  assertRunPriorityQueueInvariant,
  type RunPriorityPatch,
} from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { resolveRunPriority, type RunPriorityView } from "./state.js";
import type { RunPrioritySettings } from "@myrmidon/shared";
import { applyStoredRunPriority, releaseFocusChanged } from "./sync.js";
import { mutateCompanyBehaviorSettings, readCompanyBehaviorSettings } from "../behavior-settings/store.js";
import type { CompanyReleaseFocus } from "./state.js";

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
  /** Re-read the stored row and put it in force for the live sweeps; returns what is in force. */
  applyStored(): Promise<RunPrioritySettings>;
  /** Ask the queued-run sweep to run shortly, so held runs reorder at once. */
  scheduleResweep(): void;
  /** Make runs parked by strict release focus due now (focus changed). */
  advanceDeferredRuns?(): Promise<unknown>;
  /** Tell the other board processes to re-read the stored settings. */
  publishChanged?(): Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface RunPriorityService {
  read(): Promise<RunPriorityView>;
  readCompany(companyId: string): Promise<CompanyReleaseFocus>;
  updateCompany(companyId: string, patch: CompanyReleaseFocus, actor: RunPriorityActor): Promise<void>;
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
    applyStored: () => applyStoredRunPriority(db),
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    readCompany: async (companyId) => {
      const stored = (await readCompanyBehaviorSettings(db, companyId))?.releaseFocus;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        const focus = stored as Record<string, unknown>;
        if ((focus.currentRelease === null || typeof focus.currentRelease === "string") && typeof focus.strictReleaseFocus === "boolean") {
          return { currentRelease: focus.currentRelease, strictReleaseFocus: focus.strictReleaseFocus };
        }
      }
      return { currentRelease: null, strictReleaseFocus: false };
    },
    updateCompany: async (companyId, patch, actor) => {
      await mutateCompanyBehaviorSettings(db, companyId, (current) => ({
        next: { ...current, releaseFocus: patch }, result: undefined,
      }));
      await deps.logActivity({
        companyId, ...actor, action: "company.release_focus.updated",
        entityType: "company", entityId: companyId, details: { next: patch },
      });
      await deps.publishChanged?.().catch((err: unknown) => {
        logger.warn({ err }, "release focus saved but process notification failed");
      });
      await deps.applyStored();
      await deps.advanceDeferredRuns?.();
      deps.scheduleResweep();
    },
    read: async () => {
      const general = await deps.settings.getGeneral();
      return resolveRunPriority(general.runPriority, env);
    },

    update: async (patch, actor) =>
      withRunPriorityTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveRunPriority(general.runPriority, env).settings;
        const next = mergeRunPrioritySettings(before, patch);
        assertRunPriorityQueueInvariant(next);

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
        // The in-force settings are process memory: the other board processes
        // re-read the stored row on this notice (settings-appliers). Publish
        // first, so a failure below cannot keep them from converging.
        await deps.publishChanged?.().catch((err: unknown) => {
          logger.warn({ err }, "run priority saved but process notification failed");
        });
        // This process applies the stored row too, not its own `next`: two
        // concurrent saves converge to the value in the database.
        const inForce = await deps.applyStored();
        if (releaseFocusChanged(before, inForce)) {
          await deps.advanceDeferredRuns?.().catch((err: unknown) => {
            logger.warn({ err }, "release focus changed but deferred runs were not advanced");
          });
        }
        deps.scheduleResweep();
        logger.info(
          { settings: inForce, actorType: actor.actorType },
          "run queue priority settings updated without a restart",
        );
        return { settings: inForce, source: "settings" as const };
      }),
  };
}
