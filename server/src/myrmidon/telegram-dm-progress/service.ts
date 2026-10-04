// server/src/myrmidon/telegram-dm-progress/service.ts
//
// myrmidon(DM-PROGRESS): read and change the live-progress settings of the
// bridged Telegram DM status message.
//
// `instance_settings.general.telegramDmProgress` is the stored value; the
// environment variables stay forced overrides (see
// packages/shared/src/myrmidon-telegram-dm-progress.ts). A change writes the
// row, drops the sweep's short cache and records the change in the activity
// log of every company — the next milestone sweep already uses it, without a
// restart. The read-write-audit sequence runs through one queue so two
// overlapping requests cannot commit in one order and audit in the other
// (same shape as the budget enforcement settings).

import type { Db } from "@paperclipai/db";
import {
  TELEGRAM_DM_PROGRESS_SETTINGS_KEY,
  mergeTelegramDmProgressSettings,
  resolveTelegramDmProgress,
  type ResolvedTelegramDmProgress,
  type TelegramDmProgressPatch,
  type TelegramDmProgressSettings,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  invalidateTelegramDmProgressSettingsCache,
  readTelegramDmProgressSettings,
} from "./settings.js";

export type TelegramDmProgressView = ResolvedTelegramDmProgress;

/** Who changed the settings, for the activity log. */
export interface TelegramDmProgressActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type TelegramDmProgressAuditEntry = TelegramDmProgressActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface TelegramDmProgressServiceDeps {
  getGeneral(): Promise<unknown>;
  updateGeneral(patch: { telegramDmProgress: TelegramDmProgressSettings }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: TelegramDmProgressAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface TelegramDmProgressService {
  /** The settings in force and where each value came from. */
  read(): Promise<TelegramDmProgressView>;
  /** Persist and audit a change; returns the settings now in force. */
  update(patch: TelegramDmProgressPatch, actor: TelegramDmProgressActor): Promise<TelegramDmProgressView>;
}

/** `instance.telegram_dm_progress.updated` — the audit action of a change. */
export const TELEGRAM_DM_PROGRESS_ACTION = "instance.telegram_dm_progress.updated";

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
    ? (general as Record<string, unknown>)[TELEGRAM_DM_PROGRESS_SETTINGS_KEY]
    : undefined;
}

export function telegramDmProgressService(
  db: Db,
  overrides: Partial<TelegramDmProgressServiceDeps> = {},
): TelegramDmProgressService {
  const settings = instanceSettingsService(db);
  const deps: TelegramDmProgressServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) =>
      settings.updateGeneral({ telegramDmProgress: patch.telegramDmProgress }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: () =>
      readTelegramDmProgressSettings({ getGeneral: deps.getGeneral, env, cacheMs: 0 }),

    update: async (patch, actor) =>
      withTransition(async () => {
        let current: unknown;
        try {
          current = storedValue(await deps.getGeneral());
        } catch {
          current = undefined;
        }
        const next = mergeTelegramDmProgressSettings(current, patch);
        await deps.updateGeneral({ telegramDmProgress: next });
        invalidateTelegramDmProgressSettingsCache();
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
              action: TELEGRAM_DM_PROGRESS_ACTION,
              entityType: "instance_settings",
              entityId: TELEGRAM_DM_PROGRESS_SETTINGS_KEY,
              details: { settings: next, patch },
            }),
          ),
        );
        return resolveTelegramDmProgress({ stored: next, env });
      }),
  };
}

