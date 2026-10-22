import type { Db } from "@paperclipai/db";
import { listAdapterModels, listEnabledServerAdapters } from "../../adapters/registry.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import { modelMenuRoutes } from "./routes.js";
import { modelMenuService, type ModelMenuGeneralSettings, type ModelMenuService } from "./service.js";
import type { ModelMenuAdapterType } from "./state.js";

/**
 * Entry point of the model menu setting (myrmidon 1.6.6 MODEL-MENU, part B).
 *
 * The setting is one instance settings row, `general.modelMenu`, and the
 * catalog the editor resolves it against comes from the adapter registry — the
 * same source `/model` uses in the bot. Nothing is cached: every read goes to
 * the settings row and the adapter, so a save in the web interface is in force
 * on the next `/model` without a restart.
 */

export function myrmidonModelMenuRoutes(db: Db) {
  return modelMenuRoutes(db, createModelMenuService(db));
}

/** The service the routes run on: instance settings, the activity log, adapter catalogs. */
export function createModelMenuService(db: Db): ModelMenuService {
  const settings = instanceSettingsService(db);
  return modelMenuService({
    settings: {
      // The settings service types the whole general row; the menu reads the one
      // key it owns, narrowed here once.
      getGeneral: async () =>
        (await settings.getGeneral()) as unknown as ModelMenuGeneralSettings,
      updateGeneral: (patch) => settings.updateGeneral(patch),
    },
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    listModels: (adapterType) => listAdapterModels(adapterType),
    listAdapterTypes: async () => adapterTypes(),
  });
}

/**
 * The picker's adapter types: every enabled adapter, in enabled order. Types
 * without a model source stay in the list on purpose — the editor then shows
 * the empty catalog instead of silently resolving against a different adapter.
 */
function adapterTypes(): ModelMenuAdapterType[] {
  return listEnabledServerAdapters().map((adapter) => ({
    type: adapter.type,
    label: adapter.type,
  }));
}

export { modelMenuService, MODEL_MENU_DEFAULT_ADAPTER_TYPE } from "./service.js";
export type { ModelMenuActor, ModelMenuService } from "./service.js";
export type { ModelMenuAdapterType, ModelMenuView } from "./state.js";