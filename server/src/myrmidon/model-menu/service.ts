import {
  MODEL_MENU_UPDATED_ACTION,
  mergeModelMenuSettings,
  normalizeModelMenuSettings,
  resolveModelMenu,
  type ModelMenuCatalogModel,
  type ModelMenuSettings,
  type ModelMenuSettingsPatch,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import type { LogActivityInput } from "../../services/activity-log.js";
import type { ModelMenuAdapterType, ModelMenuView } from "./state.js";

/**
 * Read and change the model menu without a restart (myrmidon 1.6.6 MODEL-MENU,
 * part B).
 *
 * Contract: `instance_settings.general.modelMenu` is the source of truth. The
 * row is read on every `/model` and on every editor load, so a save in the web
 * interface is already in force on the next keystroke of the bot — no restart,
 * the same contract the host disk threshold follows. Absent or unusable, the
 * row resolves to the automatic groups by provider family.
 */

/** The bot adapter the menu groups by default: the Telegram bot runs the gateway. */
export const MODEL_MENU_DEFAULT_ADAPTER_TYPE = "hermes_gateway";

/** The entity the activity log attributes a menu write to. */
export const MODEL_MENU_ENTITY_ID = "model-menu";

export interface ModelMenuActor {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId: string | null;
}

/** The general settings row this setting lives in. */
export interface ModelMenuGeneralSettings {
  modelMenu?: unknown;
}

export interface ModelMenuServiceDeps {
  settings: {
    getGeneral(): Promise<ModelMenuGeneralSettings>;
    updateGeneral(patch: { modelMenu: ModelMenuSettings }): Promise<unknown>;
  };
  listCompanyIds(): Promise<string[]>;
  logActivity(entry: LogActivityInput): Promise<unknown>;
  /** Models an adapter type offers; unknown types answer an empty catalog. */
  listModels(adapterType: string): Promise<ModelMenuCatalogModel[]>;
  /** Adapter types the editor may pick, in picker order. */
  listAdapterTypes(): Promise<ModelMenuAdapterType[]>;
}

export interface ModelMenuService {
  read(options?: { adapterType?: string }): Promise<ModelMenuView>;
  update(
    patch: ModelMenuSettingsPatch,
    actor: ModelMenuActor,
    options?: { adapterType?: string },
  ): Promise<ModelMenuView>;
}

/**
 * Writes are serialised: the update is a read-modify-write of one settings row,
 * and two overlapping saves would otherwise lose the first one's keys.
 */
let modelMenuTransitionQueue: Promise<void> = Promise.resolve();

function withModelMenuTransition<T>(run: () => Promise<T>): Promise<T> {
  const turn = modelMenuTransitionQueue.then(run);
  modelMenuTransitionQueue = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** The adapter type a read resolves against. */
function pickAdapterType(requested: string | undefined, types: ModelMenuAdapterType[]): string {
  const trimmed = requested?.trim();
  // An explicit request wins even when the adapter is unknown: the empty
  // catalog then shows the truth instead of a silently different adapter.
  if (trimmed) return trimmed;
  if (types.some((entry) => entry.type === MODEL_MENU_DEFAULT_ADAPTER_TYPE)) {
    return MODEL_MENU_DEFAULT_ADAPTER_TYPE;
  }
  return types[0]?.type ?? "";
}

export function modelMenuService(deps: ModelMenuServiceDeps): ModelMenuService {
  /**
   * One view of the setting: the stored row, the catalog of the adapter in
   * question and the menu the two produce. The resolver normalises the stored
   * value itself, so a hand-edited row falls back to the automatic menu rather
   * than to half a tree.
   */
  async function read(options?: { adapterType?: string }): Promise<ModelMenuView> {
    const general = await deps.settings.getGeneral();
    const adapterTypes = await deps.listAdapterTypes();
    const adapterType = pickAdapterType(options?.adapterType, adapterTypes);
    const catalog = adapterType ? await deps.listModels(adapterType) : [];
    return {
      adapterType,
      adapterTypes,
      catalog,
      stored: normalizeModelMenuSettings(general.modelMenu),
      menu: resolveModelMenu({ catalog, settings: general.modelMenu }),
    };
  }

  return {
    read,

    update: (patch, actor, options) =>
      withModelMenuTransition(async () => {
        const general = await deps.settings.getGeneral();
        const before = normalizeModelMenuSettings(general.modelMenu);
        const next = mergeModelMenuSettings(before, patch);

        await deps.settings.updateGeneral({ modelMenu: next });

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
              action: MODEL_MENU_UPDATED_ACTION,
              entityType: "instance_settings",
              entityId: MODEL_MENU_ENTITY_ID,
              details: {
                previous: before,
                next,
                changedKeys: (["groups", "hidden"] as const).filter(
                  (key) => (before?.[key] ?? null) !== (next[key] ?? null),
                ),
              },
            }),
          ),
        );

        logger.info(
          {
            groups: next.groups?.length ?? 0,
            hidden: next.hidden?.length ?? 0,
            actorType: actor.actorType,
          },
          "model menu updated without a restart",
        );
        return read(options);
      }),
  };
}