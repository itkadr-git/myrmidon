// Behavior settings management (myrmidon 1.7, SETTINGS-TO-UI A):
// read, change and apply behavior settings without restarting the server.
//
// Contract: `instance_settings.general.behaviorSettings` is the source of truth
// for instance-scoped settings once an operator saves them; the environment
// stays the default for an instance that never did (see
// packages/shared/src/myrmidon-behavior-settings.ts for the precedence and the
// value rules). Company-scoped settings live under the
// `behaviorSettingsByCompany` key of the same row, keyed by companyId, the
// same shape telegram-notify uses for per-company state. A change writes the
// row, records it in the activity log, then applies it to the process-wide
// settings.
//
// Two overlapping requests can commit their rows in one order and reach the
// in-memory apply in the other; the audit log would then disagree with the
// settings actually in force. Every request's read-write-audit-apply sequence
// runs through one queue (see `withBehaviorSettingsTransition`), exactly as the
// runtime-limits transition does.

import type { Db } from "@paperclipai/db";
import {
  resolveBehaviorSettings,
  mergeBehaviorSettings,
  type BehaviorSettingsPatch,
  type ResolvedBehaviorSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  readInstanceBehaviorSettings,
  readCompanyBehaviorSettings,
  mutateInstanceBehaviorSettings,
  mutateCompanyBehaviorSettings,
} from "./store.js";

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
    readInstance(): Promise<Record<string, unknown> | undefined>;
    writeInstance(
      change: (current: Record<string, unknown> | undefined) => { next: Record<string, unknown> },
    ): Promise<Record<string, unknown>>;
    readCompany(companyId: string): Promise<Record<string, unknown> | undefined>;
    writeCompany(
      companyId: string,
      change: (current: Record<string, unknown> | undefined) => { next: Record<string, unknown> },
    ): Promise<Record<string, unknown>>;
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
    instanceSettings: {
      readInstance: () => readInstanceBehaviorSettings(db),
      writeInstance: (change) =>
        mutateInstanceBehaviorSettings(db, (current) => {
          const { next } = change(current);
          return { next, result: next };
        }),
      readCompany: (companyId) => readCompanyBehaviorSettings(db, companyId),
      writeCompany: (companyId, change) =>
        mutateCompanyBehaviorSettings(db, companyId, (current) => {
          const { next } = change(current);
          return { next, result: next };
        }),
    },
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    apply: () => undefined,
    scheduleResweep: () => undefined,
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<BehaviorSettingsView> => {
      const stored = await deps.instanceSettings.readInstance();
      return resolveBehaviorSettings({ stored, env });
    },

    readCompany: async (companyId: string): Promise<BehaviorSettingsView> => {
      const stored = await deps.instanceSettings.readCompany(companyId);
      return resolveBehaviorSettings({ stored, env });
    },

    updateInstance: async (patch, actor) =>
      withBehaviorSettingsTransition(async () => {
        const before = await deps.instanceSettings.readInstance();
        const previous = resolveBehaviorSettings({ stored: before, env });

        const next = await deps.instanceSettings.writeInstance((current) => ({
          next: mergeBehaviorSettings(current ?? {}, patch),
        }));

        const changedKeys = changedSettingKeys(previous.settings, next, patch);

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
              details: { previous: previous.settings, next, changedKeys },
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
        const before = await deps.instanceSettings.readCompany(companyId);
        const previous = resolveBehaviorSettings({ stored: before, env });

        const next = await deps.instanceSettings.writeCompany(companyId, (current) => ({
          next: mergeBehaviorSettings(current ?? {}, patch),
        }));

        const changedKeys = changedSettingKeys(previous.settings, next, patch);

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
          details: { previous: previous.settings, next, changedKeys },
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

function changedSettingKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  patch: BehaviorSettingsPatch,
): string[] {
  const changedKeys: string[] = [];
  for (const key of Object.keys(patch)) {
    if (previous[key] !== next[key]) {
      changedKeys.push(key);
    }
  }
  return changedKeys;
}

// Re-export so route/app wiring can preserve our keys across vendor general
// writes without importing the store module separately.
export { preserveBehaviorSettingsGeneralKeys } from "./store.js";
