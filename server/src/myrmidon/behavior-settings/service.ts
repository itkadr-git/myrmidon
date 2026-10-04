// Behavior settings management (myrmidon 1.7, SETTINGS-TO-UI A):
// read, change and apply behavior settings without restarting the server.
//
// Contract: `instance_settings.general.behaviorSettings` is the source of truth
// for instance-scoped settings once an operator saves them; the environment
// stays the default for an instance that never did (see 
// packages/shared/src/myrmidon-behavior-settings.ts for the precedence and the
// value rules). A change writes the row, records it in the activity log for 
// every company, then applies it to the process-wide settings.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// settings actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (see `withBehaviorSettingsTransition`), exactly as the
// task-drain transition does.

import type { Db } from "@paperclipai/db";
import {
  behaviorSettingRegistry,
  resolveBehaviorSettings,
  mergeBehaviorSettings,
  type BehaviorSettingsPatch,
  type ResolvedBehaviorSettings,
  SettingSource,
  SettingScope,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { companySettingsService } from "../../services/company-settings-service.js";

export type BehaviorSettingsView = ResolvedBehaviorSettings;

/** Who changed the settings, for the activity log. */
export interface BehaviorSettingsActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type BehaviorSettingsAuditEntry = BehaviorSettingsActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface BehaviorSettingsServiceDeps {
  instanceSettings: {
    getGeneral(): Promise<{ behaviorSettings?: unknown }>;
    updateGeneral(patch: { behaviorSettings: Record<string, unknown> }): Promise<unknown>;
  };
  companySettings: {
    get(companyId: string): Promise<{ behaviorSettings?: unknown }>;
    update(companyId: string, patch: { behaviorSettings: Record<string, unknown> }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BehaviorSettingsAuditEntry): Promise<unknown>;
  /** Put the settings in force on the live system. */
  apply(settings: Record<string, unknown>): void;
  /** Ask for any necessary resweeps after settings change. */
  scheduleResweep(): void;
  env?: Record<string, string | undefined>;
}

export interface BehaviorSettingsService {
  /** Effective settings and where each value came from. */
  read(): Promise<BehaviorSettingsView>;
  /** Read settings for a specific company */
  readCompany(companyId: string): Promise<BehaviorSettingsView>;
  /** Persist, audit and apply a patch for instance settings; returns the settings now in force. */
  updateInstance(patch: BehaviorSettingsPatch, actor: BehaviorSettingsActor): Promise<BehaviorSettingsView>;
  /** Persist, audit and apply a patch for company settings; returns the settings now in force. */
  updateCompany(companyId: string, patch: BehaviorSettingsPatch, actor: BehaviorSettingsActor): Promise<BehaviorSettingsView>;
}

/** `instance.behavior_settings.updated` — the audit action of an instance settings change. */
export const BEHAVIOR_SETTINGS_INSTANCE_ACTION = "instance.behavior_settings.updated";
/** `company.behavior_settings.updated` — the audit action of a company settings change. */
export const BEHAVIOR_SETTINGS_COMPANY_ACTION = "company.behavior_settings.updated";

let behaviorSettingsTransitionQueue: Promise<void> = Promise.resolve();

function withBehaviorSettingsTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = behaviorSettingsTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  behaviorSettingsTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function behaviorSettingsService(
  db: Db,
  overrides: Partial<BehaviorSettingsServiceDeps> = {},
): BehaviorSettingsService {
  const deps: BehaviorSettingsServiceDeps = {
    instanceSettings: instanceSettingsService(db),
    companySettings: companySettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: () => undefined,
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<BehaviorSettingsView> => {
      const general = await deps.instanceSettings.getGeneral();
      return resolveBehaviorSettings({ stored: general.behaviorSettings, env });
    },

    readCompany: async (companyId: string): Promise<BehaviorSettingsView> => {
      const companyData = await deps.companySettings.get(companyId);
      return resolveBehaviorSettings({ stored: companyData.behaviorSettings, env });
    },

    updateInstance: async (patch, actor) =>
      withBehaviorSettingsTransition(async () => {
        const general = await deps.instanceSettings.getGeneral();
        const before = resolveBehaviorSettings({ stored: general.behaviorSettings, env });
        
        // Get current settings and merge with patch
        const currentSettings = general.behaviorSettings ? {...general.behaviorSettings} : {};
        const next = mergeBehaviorSettings(currentSettings, patch) as Record<string, unknown>;
        
        // Determine which keys changed
        const changedKeys: string[] = [];
        for (const [key, value] of Object.entries(patch)) {
          if (before.settings[key] !== value) {
            changedKeys.push(key);
          }
        }

        await deps.instanceSettings.updateGeneral({ behaviorSettings: next });

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
              action: BEHAVIOR_SETTINGS_INSTANCE_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        // Only after the row and the audit records are committed: the settings in
        // force must never run ahead of what the log says they are.
        deps.apply(next);
        deps.scheduleResweep();
        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "behavior settings updated without a restart",
        );
        return resolveBehaviorSettings({ stored: next, env });
      }),

    updateCompany: async (companyId, patch, actor) =>
      withBehaviorSettingsTransition(async () => {
        const companyData = await deps.companySettings.get(companyId);
        const before = resolveBehaviorSettings({ stored: companyData.behaviorSettings, env });
        
        // Get current settings and merge with patch
        const currentSettings = companyData.behaviorSettings ? {...companyData.behaviorSettings} : {};
        const next = mergeBehaviorSettings(currentSettings, patch) as Record<string, unknown>;
        
        // Determine which keys changed
        const changedKeys: string[] = [];
        for (const [key, value] of Object.entries(patch)) {
          if (before.settings[key] !== value) {
            changedKeys.push(key);
          }
        }

        await deps.companySettings.update(companyId, { behaviorSettings: next });

        await deps.logActivity({
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: BEHAVIOR_SETTINGS_COMPANY_ACTION,
          entityType: "company_settings",
          entityId: companyId,
          details: { previous: before.settings, next, changedKeys },
        });

        // Only after the row and the audit records are committed: the settings in
        // force must never run ahead of what the log says they are.
        deps.apply(next);
        deps.scheduleResweep();
        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType, companyId },
          "company behavior settings updated without a restart",
        );
        return resolveBehaviorSettings({ stored: next, env });
      }),
  };
}