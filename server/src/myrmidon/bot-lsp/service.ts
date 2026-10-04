// Read and change the bot language-server policy without a restart
// (myrmidon BOT-LSP-DEFAULTS).
//
// Contract: `instance_settings.general.botLsp` is the source of truth once an
// operator saves it; the module defaults apply for an instance that never did
// (coding roles limited, every other role off — see
// packages/shared/src/myrmidon-bot-lsp.ts). A change writes the row and records
// it in the activity log for every company. Nothing is applied to a live
// object: the profile compiler re-reads the row on every reconcile tick, and a
// changed `lsp` block is a config.yaml change, which the reconciler applies
// with the bot's admission paused (the same path a model change takes).
//
// Every write runs through one queue so the audit order matches the stored
// value, as the parallel-helpers and runtime-limits settings do.

import type { Db } from "@paperclipai/db";
import {
  countBotLspModes,
  effectiveBotLspSettings,
  resolveBotLsp,
  type BotLspAgentMode,
  type BotLspModeCounts,
  type BotLspSettings,
  type BotLspSettingsPatch,
  type EffectiveBotLspSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";

export interface BotLspView {
  settings: BotLspSettings;
  /** Every value in force, defaults filled in (shown, not stored). */
  effective: EffectiveBotLspSettings;
  /** The bots and the mode each one resolves to right now. */
  agents: BotLspAgentMode[];
  counts: BotLspModeCounts;
}

export interface BotLspActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

export type BotLspAuditEntry = BotLspActor & {
  companyId: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
};

export interface BotLspAgentCard {
  id: string;
  name: string;
  role: string | null;
  adapterConfig: Record<string, unknown>;
}

export interface BotLspServiceDeps {
  settings: {
    getGeneral(): Promise<{ botLsp?: unknown }>;
    updateGeneral(patch: { botLsp: BotLspSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: BotLspAuditEntry): Promise<unknown>;
  /** The container bots whose mode the view reports. Read-only. */
  listBots(): Promise<BotLspAgentCard[]>;
}

export interface BotLspService {
  read(): Promise<BotLspView>;
  update(patch: BotLspSettingsPatch, actor: BotLspActor): Promise<BotLspView>;
}

/** `instance.bot_lsp.updated` — the audit action of a change. */
export const BOT_LSP_ACTION = "instance.bot_lsp.updated";

const FIELDS = [
  "codingRoles",
  "codingMode",
  "nonCodingMode",
  "idleTimeoutSeconds",
  "tsserverMemoryMb",
  "excludeRoots",
] as const satisfies ReadonlyArray<keyof BotLspSettings>;

let botLspTransitionQueue: Promise<void> = Promise.resolve();

function withBotLspTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = botLspTransitionQueue.then(run);
  botLspTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

function asStored(value: unknown): BotLspSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as BotLspSettings) : {};
}

/** Stored + patch: a field left out stays, `null` removes it. */
export function mergeBotLspSettings(before: BotLspSettings, patch: BotLspSettingsPatch): BotLspSettings {
  const next: Record<string, unknown> = { ...before };
  for (const key of FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as BotLspSettings;
}

export function botLspService(db: Db, overrides: Partial<BotLspServiceDeps> = {}): BotLspService {
  const deps: BotLspServiceDeps = {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    // The bots are company-scoped, the settings instance-level; the wiring
    // (index.ts) supplies the cross-company walk.
    listBots: async () => [],
    ...overrides,
  };

  async function view(settings: BotLspSettings): Promise<BotLspView> {
    const bots = await deps.listBots();
    // The same resolution the profile compiler applies, so the view shows
    // what each bot actually runs with.
    const agents: BotLspAgentMode[] = bots.map((bot) => {
      const resolved = resolveBotLsp(bot.role, bot.adapterConfig, settings);
      return { id: bot.id, name: bot.name, role: bot.role, mode: resolved.mode, source: resolved.source };
    });
    return {
      settings,
      effective: effectiveBotLspSettings(settings),
      agents,
      counts: countBotLspModes(agents),
    };
  }

  return {
    read: async () => {
      const general = await deps.settings.getGeneral();
      return view(asStored(general.botLsp));
    },

    update: async (patch, actor) =>
      withBotLspTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = asStored(general.botLsp);
        const next = mergeBotLspSettings(before, patch);
        const changedKeys = FIELDS.filter(
          (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(next[key] ?? null),
        );

        await deps.settings.updateGeneral({ botLsp: next });

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
              action: BOT_LSP_ACTION,
              entityType: "instance_settings",
              entityId: "default",
              details: { previous: before, next, changedKeys },
            }),
          ),
        );

        logger.info({ botLsp: next, changedKeys, actorType: actor.actorType }, "bot language-server policy updated without a restart");
        return view(next);
      }),
  };
}
