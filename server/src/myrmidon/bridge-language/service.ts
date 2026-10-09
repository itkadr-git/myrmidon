// server/src/myrmidon/bridge-language/service.ts
//
// myrmidon(1.6.5-TG-LOCALE-C): read and change the instance-wide default
// language of the bridged Telegram DM.
//
// `instance_settings.general.bridgeLanguage` is the stored value; the
// environment variable stays a forced override (see
// packages/shared/src/myrmidon-bridge-language.ts). A change writes the row,
// drops the reader's short cache and records the change in the activity log of
// every company — the very next bridged reply already uses it, without a
// restart. The read-write-audit sequence runs through one queue so two
// overlapping requests cannot commit in one order and audit in the other (the
// same shape as the DM-progress settings).

import type { Db } from "@paperclipai/db";
import {
  BRIDGE_LANGUAGE_SETTINGS_KEY,
  mergeBridgeLanguageSettings,
  resolveBridgeLanguage,
  type BridgeLanguageSettings,
  type PatchBridgeLanguage,
  type ResolvedBridgeLanguage,
} from "@paperclipai/shared";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  invalidateBridgeLanguageSettingsCache,
  readBridgeLanguageSettings,
} from "./settings.js";

export type BridgeLanguageView = ResolvedBridgeLanguage;

/** Who changed the setting, for the activity log. */
export interface BridgeLanguageActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** One activity row; the database service fills in the entity fields. */
export type BridgeLanguageAuditEntry = BridgeLanguageActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

/** Everything the service needs, so tests can run it without a database. */
export interface BridgeLanguageServiceDeps {
  getGeneral(): Promise<unknown>;
  updateGeneral(patch: { bridgeLanguage: BridgeLanguageSettings }): Promise<unknown>;
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BridgeLanguageAuditEntry): Promise<unknown>;
  env?: Record<string, string | undefined>;
}

export interface BridgeLanguageService {
  /** The instance language in force and where the value came from. */
  read(): Promise<BridgeLanguageView>;
  /** Persist and audit a change; returns the value now in force. */
  update(patch: PatchBridgeLanguage, actor: BridgeLanguageActor): Promise<BridgeLanguageView>;
}

/** `instance.bridge_language.updated` — the audit action of a change. */
export const BRIDGE_LANGUAGE_ACTION = "instance.bridge_language.updated";

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
    ? (general as Record<string, unknown>)[BRIDGE_LANGUAGE_SETTINGS_KEY]
    : undefined;
}

export function bridgeLanguageService(
  db: Db,
  overrides: Partial<BridgeLanguageServiceDeps> = {},
): BridgeLanguageService {
  const settings = instanceSettingsService(db);
  const deps: BridgeLanguageServiceDeps = {
    getGeneral: () => settings.getGeneral(),
    updateGeneral: (patch) => settings.updateGeneral({ bridgeLanguage: patch.bridgeLanguage }),
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    ...overrides,
  };
  const env = deps.env ?? process.env;

  return {
    read: async () => readBridgeLanguageSettings({ getGeneral: deps.getGeneral, env, cacheMs: 0 }),

    update: async (patch, actor) =>
      withTransition(async () => {
        let current: unknown;
        try {
          current = storedValue(await deps.getGeneral());
        } catch {
          current = undefined;
        }
        const next = mergeBridgeLanguageSettings(current, patch);
        await deps.updateGeneral({ bridgeLanguage: next });
        invalidateBridgeLanguageSettingsCache();
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
              action: BRIDGE_LANGUAGE_ACTION,
              entityType: "instance_settings",
              entityId: BRIDGE_LANGUAGE_SETTINGS_KEY,
              details: { settings: next, patch },
            }),
          ),
        );
        return resolveBridgeLanguage({ stored: next, env });
      }),
  };
}