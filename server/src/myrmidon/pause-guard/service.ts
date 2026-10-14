// Settings of the forgotten-pause guard (myrmidon 1.6.5 PAUSE-GUARD): read,
// change and put them in force without restarting the server.
//
// Contract: `instance_settings.general.pauseGuard` is the source of truth once
// an operator saves it; the environment stays the default for an instance that
// never did (see packages/shared/src/myrmidon-pause-guard.ts for the
// precedence and the value rules). A change writes the row, records it in the
// activity log for every company and asks the guard to run its next pass at
// the next scheduler tick instead of waiting out the previous interval.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// settings actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (`withPauseGuardTransition`), exactly as the run
// admission limits transition does.

import type { Db } from "@paperclipai/db";
import {
  PAUSE_GUARD_SETTING_KEYS,
  mergePauseGuardSettings,
  resolvePauseGuardSettings,
  type PauseGuardSettingKey,
  type PauseGuardSettings,
  type PauseGuardSettingsPatch,
  type PauseGuardSettingsSource,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

/** Effective settings and where each value came from. */
export type PauseGuardView = {
  settings: PauseGuardSettings;
  sources: Record<PauseGuardSettingKey, PauseGuardSettingsSource>;
};

/** Who changed the settings, for the activity log. */
export interface PauseGuardActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type PauseGuardAuditEntry = PauseGuardActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface PauseGuardServiceDeps {
  settings: {
    getGeneral(): Promise<{ pauseGuard?: unknown }>;
    updateGeneral(patch: { pauseGuard: PauseGuardSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: PauseGuardAuditEntry): Promise<unknown>;
  /**
   * Ask the guard to run its next pass at the next scheduler tick, so a
   * settings change takes effect at once instead of after the previous
   * interval. Absent when the process runs no scheduler (a test, a route-only
   * process).
   */
  apply?(settings: PauseGuardSettings): void;
  env?: Record<string, string | undefined>;
}

export interface PauseGuardService {
  /** Effective settings and where each value came from. */
  read(): Promise<PauseGuardView>;
  /** Persist, audit and apply a patch; returns the settings now in force. */
  update(patch: PauseGuardSettingsPatch, actor: PauseGuardActor): Promise<PauseGuardView>;
}

/** `instance.pause_guard.updated` — the audit action of a settings change. */
export const PAUSE_GUARD_SETTINGS_ACTION = "instance.pause_guard.updated";

let pauseGuardTransitionQueue: Promise<void> = Promise.resolve();

function withPauseGuardTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = pauseGuardTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  pauseGuardTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function pauseGuardService(
  db: Db,
  overrides: Partial<PauseGuardServiceDeps> = {},
): PauseGuardService {
  const deps: PauseGuardServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<PauseGuardView> => {
      const general = await deps.settings.getGeneral();
      return resolvePauseGuardSettings({ stored: general.pauseGuard, env });
    },

    update: async (patch, actor) =>
      withPauseGuardTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolvePauseGuardSettings({ stored: general.pauseGuard, env });
        const next = mergePauseGuardSettings(before.settings, patch);
        const changedKeys = PAUSE_GUARD_SETTING_KEYS.filter(
          (key) => JSON.stringify(before.settings[key]) !== JSON.stringify(next[key]),
        );

        await deps.settings.updateGeneral({ pauseGuard: next });

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
              action: PAUSE_GUARD_SETTINGS_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the settings
        // in force must never run ahead of what the log says they are.
        deps.apply?.(next);
        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "pause guard settings updated without a restart",
        );
        return resolvePauseGuardSettings({ stored: next, env });
      }),
  };
}