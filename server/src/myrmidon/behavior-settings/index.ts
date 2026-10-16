// Behavior settings module entry point (myrmidon 1.7, SETTINGS-TO-UI A)

import type { Db } from "@paperclipai/db";
import { behaviorSettingRegistry, resolveBehaviorSettings } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { behaviorSettingsRoutes } from "./routes.js";
import { behaviorSettingsService, type BehaviorSettingsServiceDeps } from "./service.js";
import { applyMyrmidonRunEnvAllow } from "@paperclipai/adapter-utils/myrmidon-run-env";
import { liveBehaviorSettingsView } from "./live.js";
import { applyLiveBehaviorSettings } from "./live.js";
import { startBotContainers, stopBotContainers } from "../bot-containers/startup.js";
import { startStackCheckSweep, stopStackCheckSweep } from "../stack-registry/index.js";

let runtimeDb: Db | null = null;

function scheduleBehaviorSettingsResweep(): void {
  if (!runtimeDb) return;
  stopBotContainers();
  startBotContainers(runtimeDb);
  stopStackCheckSweep();
  startStackCheckSweep(runtimeDb);
}

export {
  behaviorSettingsService,
  type BehaviorSettingsService,
  type BehaviorSettingsActor,
  type BehaviorSettingsServiceDeps,
  BEHAVIOR_SETTINGS_INSTANCE_ACTION,
  BEHAVIOR_SETTINGS_COMPANY_ACTION,
} from "./service.js";

export { behaviorSettingsRoutes } from "./routes.js";

export {
  applyLiveBehaviorSettings,
  liveBehaviorSetting,
  liveBehaviorSettingsView,
} from "./live.js";

export {
  BEHAVIOR_SETTINGS_GENERAL_KEY,
  BEHAVIOR_SETTINGS_BY_COMPANY_GENERAL_KEY,
  preserveBehaviorSettingsGeneralKeys,
} from "./store.js";

/**
 * Production wiring: the stored/merged values become the process-wide live
 * settings the moment they are committed (apply-without-restart, the same
 * contract runtime-limits follows with applyRunAdmissionLimits). Parts B–E
 * read their keys through `liveBehaviorSetting`.
 */
function productionDeps(): Partial<BehaviorSettingsServiceDeps> {
    return {
      apply: (settings) => {
        const instanceSettings = Object.fromEntries(
          Object.entries(settings).filter(([key]) => {
            const definition = behaviorSettingRegistry.get(key);
            return definition?.scope === "instance";
          }),
        );
        const view = resolveBehaviorSettings({ stored: instanceSettings, env: process.env });
        applyLiveBehaviorSettings({
          settings: Object.fromEntries(Object.entries(view.settings).filter(([key]) => behaviorSettingRegistry.get(key)?.scope === "instance")),
          sources: Object.fromEntries(Object.entries(view.sources).filter(([key]) => behaviorSettingRegistry.get(key)?.scope === "instance")),
        });
        applyMyrmidonRunEnvAllow((view.settings.run_env_allow as string[] | undefined) ?? []);
      },
      scheduleResweep: scheduleBehaviorSettingsResweep,
    };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/behavior-settings[/:companyId]. */
export function myrmidonBehaviorSettingsRoutes(db: Db) {
  return behaviorSettingsRoutes(db, behaviorSettingsService(db, productionDeps()));
}

/**
 * Startup: put the stored behavior settings in force once, so an instance
 * whose values were saved from the UI does not restart on environment
 * defaults again. A failed read must not stop the server: the live holder
 * keeps the registry defaults, which is exactly the pre-feature behaviour.
 */
export async function startBehaviorSettings(db: Db): Promise<void> {
  runtimeDb = db;
  try {
    const view = await behaviorSettingsService(db, productionDeps()).read();
    applyLiveBehaviorSettings(view);
    applyMyrmidonRunEnvAllow((view.settings.run_env_allow as string[] | undefined) ?? []);
    logger.info(
      { settings: view.settings, sources: view.sources },
      "behavior settings at startup",
    );
  } catch (err) {
    logger.error(
      { err },
      "failed to read the stored behavior settings; the environment values stay in force",
    );
  }
}
