// Bot draft-directory lifecycle settings (myrmidon BOT-DISK-A): read and change
// them without restarting the server.
//
// Contract: `instance_settings.general.botDisk` is the source of truth once an
// operator saves it; the environment stays the first-start default (see
// packages/shared/src/myrmidon-bot-disk.ts for the precedence and the value
// rules). A change writes the row and records it in the activity log for
// every company, the same way the runtime limits do. The sweep re-reads the
// row on every maintenance tick (see `resolveBotDiskLifecycleConfig`), so the
// next tick already uses the new values.
//
// Every request's read-write-audit sequence runs through one queue, so two
// overlapping PATCHes cannot commit in one order and audit in the other.

import type { Db } from "@paperclipai/db";
import {
  BOT_DISK_SETTING_KEYS,
  BOT_DISK_UPDATED_ACTION,
  mergeBotDiskSettings,
  resolveBotDiskSettings,
  type BotDiskSettings,
  type BotDiskSettingsPatch,
  type ResolvedBotDiskSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { sweepAllBotVolumes } from "./draft-lifecycle.js";

export type BotDiskView = ResolvedBotDiskSettings;

/** Who changed the settings, for the activity log. */
export interface BotDiskActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type BotDiskAuditEntry = BotDiskActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface BotDiskServiceDeps {
  settings: {
    getGeneral(): Promise<{ botDisk?: unknown }>;
    updateGeneral(patch: { botDisk: BotDiskSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BotDiskAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface BotDiskService {
  /** Effective settings and where each value came from. */
  read(): Promise<BotDiskView>;
  /** Persist and audit a patch; returns the settings now in force. */
  update(patch: BotDiskSettingsPatch, actor: BotDiskActor): Promise<BotDiskView>;
}

let botDiskTransitionQueue: Promise<void> = Promise.resolve();

function withBotDiskTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = botDiskTransitionQueue.then(run);
  // A rejected transition must not wedge every later one behind it.
  botDiskTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

export function botDiskService(
  db: Db,
  overrides: Partial<BotDiskServiceDeps> = {},
): BotDiskService {
  const deps: BotDiskServiceDeps = {
    settings: overrides.settings ?? (instanceSettingsService(db) as unknown as BotDiskServiceDeps["settings"]),
    listCompanyIds: overrides.listCompanyIds ?? (() => instanceSettingsService(db).listCompanyIds()),
    logActivity: overrides.logActivity ?? ((entry) => logActivity(db, entry)),
    env: overrides.env,
  };
  const env = deps.env ?? process.env;

  return {
    read: async (): Promise<BotDiskView> => {
      const general = await deps.settings.getGeneral();
      return resolveBotDiskSettings({ stored: general.botDisk, env });
    },

    update: async (patch, actor) =>
      withBotDiskTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = resolveBotDiskSettings({ stored: general.botDisk, env });
        const next = mergeBotDiskSettings(before.settings, patch);
        const changedKeys = BOT_DISK_SETTING_KEYS.filter((key) => before.settings[key] !== next[key]);

        await deps.settings.updateGeneral({ botDisk: next });

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
              action: BOT_DISK_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: "bot-disk",
              details: { previous: before.settings, next, changedKeys },
            }),
          ),
        );

        logger.info(
          { settings: next, changedKeys, actorType: actor.actorType },
          "bot disk lifecycle settings updated without a restart",
        );
        return resolveBotDiskSettings({ stored: next, env });
      }),
  };
}

/**
 * The lifecycle config the sweep uses on this tick, from the stored row with
 * the environment as the first-start default. Called on every maintenance
 * tick, so a PATCH takes effect at the next tick without a restart.
 */
export async function resolveBotDiskLifecycleConfig(
  settings: { getGeneral(): Promise<{ botDisk?: unknown }> },
  env: Record<string, string | undefined> = process.env,
): Promise<{ enabled: boolean; idleTtlMs: number; defaultIdleTtlMs: number }> {
  const general = await settings.getGeneral();
  const resolved = resolveBotDiskSettings({ stored: general.botDisk, env });
  const defaults = resolveBotDiskSettings({ env });
  return {
    enabled: resolved.settings.enabled,
    idleTtlMs: resolved.settings.idleTtlMs,
    defaultIdleTtlMs: defaults.settings.idleTtlMs,
  };
}

/**
 * One sweep with the settings stored right now — what the maintenance tick
 * calls. Async throughout, so a failed settings read rejects (the caller logs
 * it) instead of throwing inside the timer.
 */
export async function runBotDiskSweep(db: Db): Promise<void> {
  const settings = instanceSettingsService(db) as unknown as {
    getGeneral(): Promise<{ botDisk?: unknown }>;
  };
  await sweepAllBotVolumes(await resolveBotDiskLifecycleConfig(settings));
}
