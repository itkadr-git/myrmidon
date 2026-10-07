// server/src/myrmidon/channel-settings/service.ts
//
// myrmidon(1.7-SETTINGS-TO-UI): read and change the channel settings without a
// restart.
//
// Contract: `instance_settings.general.channelSettings` is the source of truth
// once an operator saves it, and the environment stays the override above it
// (the precedence itself lives in settings.ts). A change writes the row and
// records it in the activity log for every company, so the board can answer
// "who changed the Telegram bridge, and when".
//
// Two overlapping requests can commit their rows in one order and reach the
// audit in the other; the log would then disagree with the document actually
// stored. Every request's read-write-audit sequence runs through one queue,
// exactly as the RUNTIME-LIMITS transition does.

import type { Db } from "@paperclipai/db";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  getEffectiveChannelSettings,
  mergeChannelSettingsDocument,
  readStoredChannelSettings,
  type ChannelSettings,
  type ChannelSettingsDocument,
  type ChannelSettingsPatch,
} from "./settings.js";

/** The stored-document key inside `instance_settings.general`. */
export const CHANNEL_SETTINGS_GENERAL_KEY = "channelSettings";

/** `instance.channel_settings.updated` — the audit action of a settings change. */
export const CHANNEL_SETTINGS_ACTION = "instance.channel_settings.updated";

/** Who changed the settings, for the activity log. */
export interface ChannelSettingsActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type ChannelSettingsAuditEntry = ChannelSettingsActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests run it without a database. */
export interface ChannelSettingsServiceDeps {
  settings: {
    getGeneral(): Promise<unknown>;
    updateGeneral(patch: { channelSettings: ChannelSettingsDocument }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: ChannelSettingsAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface ChannelSettingsService {
  /** The effective settings and where each value came from. */
  read(): Promise<ChannelSettings>;
  /** Persist a patch, record it and return the settings now in force. */
  update(patch: ChannelSettingsPatch, actor: ChannelSettingsActor): Promise<ChannelSettings>;
}

let channelSettingsTransitionQueue: Promise<void> = Promise.resolve();

function withChannelSettingsTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = channelSettingsTransitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  channelSettingsTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function channelSettingsService(
  db: Db,
  overrides: Partial<ChannelSettingsServiceDeps> = {},
): ChannelSettingsService {
  const deps: ChannelSettingsServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };
  const env = deps.env ?? process.env;
  const resolve = (stored: ChannelSettingsDocument): ChannelSettings =>
    getEffectiveChannelSettings(stored, env);

  return {
    read: async () => resolve(readStoredChannelSettings(await deps.settings.getGeneral())),

    update: async (patch, actor) =>
      withChannelSettingsTransition(async () => {
        const general = await deps.settings.getGeneral();
        const next = mergeChannelSettingsDocument(readStoredChannelSettings(general), patch);
        const changedKeys = Object.keys(patch);

        if (changedKeys.length > 0) {
          await deps.settings.updateGeneral({ channelSettings: next });

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
                action: CHANNEL_SETTINGS_ACTION,
                entityType: "instance_settings",
                entityId: CHANNEL_SETTINGS_GENERAL_KEY,
                details: { changedKeys, channel: next.channel ?? {} },
              }),
            ),
          );
        }

        return resolve(next);
      }),
  };
}