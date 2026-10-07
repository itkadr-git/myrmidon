// server/src/myrmidon/owner-active-channel/service.ts
//
// myrmidon(1.7-ACTIVE-CHANNEL): read the owner active-channel status and
// change the inactivity threshold without restarting the server.
//
// `instance_settings.general.ownerActiveChannel` is the stored value; the
// environment variable stays a forced override (see
// packages/shared/src/myrmidon-owner-active-channel.ts). A change writes the
// row, drops the readers' short cache and records the change in the activity
// log of every company — the next delivery decision already uses it. The
// read-write-audit sequence runs through one queue so two overlapping
// requests cannot commit in one order and audit in the other (same shape as
// the runtime-limits service).

import type { Db } from "@paperclipai/db";
import {
  OWNER_ACTIVE_CHANNEL_SETTINGS_KEY,
  mergeOwnerActiveChannelSettings,
  resolveActiveOwnerChannel,
  resolveOwnerActiveChannelSettings,
  type OwnerActiveChannelPatch,
  type OwnerChannel,
  type OwnerActiveChannelSettings,
  type OwnerActiveChannelView,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  invalidateOwnerActiveChannelSettingsCache,
  readOwnerActiveChannelSettings,
} from "./settings.js";
import { readOwnerActivity } from "./store.js";

/** Who changed the settings, for the activity log. */
export interface OwnerActiveChannelActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type OwnerActiveChannelAuditEntry = OwnerActiveChannelActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface OwnerActiveChannelServiceDeps {
  getGeneral(): Promise<unknown>;
  updateGeneral(patch: { ownerActiveChannel: OwnerActiveChannelSettings }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: OwnerActiveChannelAuditEntry): Promise<unknown>;
  /** Last activity per channel for one owner (injectable so tests skip the db). */
  readActivity(userId: string): Promise<Record<OwnerChannel, string | null>>;
  env?: Record<string, string | undefined>;
}

export interface OwnerActiveChannelService {
  /** The status for one owner: active channel, touches, threshold and its source. */
  read(userId: string): Promise<OwnerActiveChannelView>;
  /** Persist and audit a threshold change; returns the settings now in force. */
  update(patch: OwnerActiveChannelPatch, actor: OwnerActiveChannelActor): Promise<ResolvedOwnerActiveChannelView>;
}

/** A settings-only view: what PATCH answers with (no owner to resolve for). */
export interface ResolvedOwnerActiveChannelView {
  thresholdMin: number;
  thresholdSource: OwnerActiveChannelView["thresholdSource"];
}

/** `instance.owner_active_channel.updated` — the audit action of a change. */
export const OWNER_ACTIVE_CHANNEL_ACTION = "instance.owner_active_channel.updated";

let transitionQueue: Promise<void> = Promise.resolve();

function withTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = transitionQueue.then(run);
  // Normalize to a settled void promise for the next caller in line, so a
  // rejected transition cannot wedge every later one behind it.
  transitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

function storedValue(general: unknown): unknown {
  return typeof general === "object" && general !== null
    ? (general as Record<string, unknown>)[OWNER_ACTIVE_CHANNEL_SETTINGS_KEY]
    : undefined;
}

export function ownerActiveChannelService(
  db: Db,
  overrides: Partial<OwnerActiveChannelServiceDeps> = {},
): OwnerActiveChannelService {
  const settings = instanceSettingsService(db);
  const deps: OwnerActiveChannelServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) =>
      settings.updateGeneral({ ownerActiveChannel: patch.ownerActiveChannel }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    readActivity: (userId) => readOwnerActivity(db, userId),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (userId) => {
      const resolved = await readOwnerActiveChannelSettings({
        getGeneral: deps.getGeneral,
        env,
      });
      const lastActiveAt = await deps.readActivity(userId);
      const channel = resolveActiveOwnerChannel(lastActiveAt, {
        thresholdMin: resolved.thresholdMin,
      });
      return {
        channel,
        lastActiveAt,
        thresholdMin: resolved.thresholdMin,
        thresholdSource: resolved.thresholdSource,
      };
    },

    update: async (patch, actor) =>
      withTransition(async () => {
        let current: unknown;
        try {
          current = storedValue(await deps.getGeneral());
        } catch {
          current = undefined;
        }
        const next = mergeOwnerActiveChannelSettings(current, patch);
        await deps.updateGeneral({ ownerActiveChannel: next });
        invalidateOwnerActiveChannelCacheOnUpdate();
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
              action: OWNER_ACTIVE_CHANNEL_ACTION,
              entityType: "instance_settings",
              entityId: OWNER_ACTIVE_CHANNEL_SETTINGS_KEY,
              details: { settings: next, patch },
            }),
          ),
        );
        const resolved = resolveOwnerActiveChannelSettings({ stored: next, env });
        return {
          thresholdMin: resolved.thresholdMin,
          thresholdSource: resolved.thresholdSource,
        };
      }),
  };
}

function invalidateOwnerActiveChannelCacheOnUpdate(): void {
  invalidateOwnerActiveChannelSettingsCache();
}
