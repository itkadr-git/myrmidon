// Behavior settings module entry point (myrmidon 1.7, SETTINGS-TO-UI A)

import type { Db } from "@myrmidon/db";
import { resolveBehaviorSettings } from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { behaviorSettingsRoutes } from "./routes.js";
import { behaviorSettingsService, type BehaviorSettingsServiceDeps } from "./service.js";
import { applyMyrmidonRunEnvAllow } from "@myrmidon/adapter-utils/myrmidon-run-env";
import { startBotContainers, stopBotContainers } from "../bot-containers/startup.js";
import { startStackCheckSweep, stopStackCheckSweep } from "../stack-registry/index.js";
import { applyLiveBehaviorSettings } from "./live.js";

let runtimeDb: Db | null = null;

const BOT_SWEEP_KEYS = new Set([
  "bot_containers",
  "bot_reconcile_interval_sec",
  "bot_image_allowlist",
  "bot_mount_sources",
  "bot_container_github_env_allowlist",
  "bot_yolo",
  "bot_hindsight_allowed_banks",
  "bot_mcp_servers",
]);

/** The run-env allow list in force: the saved list, or undefined to keep the environment reading. */
function applyRunEnvAllow(view: ReturnType<typeof resolveBehaviorSettings>): void {
  applyMyrmidonRunEnvAllow(
    view.sources.run_env_allow === "ui" ? (view.settings.run_env_allow as string[] | undefined) ?? [] : undefined,
  );
}

function scheduleBehaviorSettingsResweep(changedKeys: readonly string[]): void {
  if (!runtimeDb) return;
  if (changedKeys.some((key) => BOT_SWEEP_KEYS.has(key))) {
    stopBotContainers();
    startBotContainers(runtimeDb);
  }
  if (changedKeys.includes("stack_check_interval_sec")) {
    stopStackCheckSweep();
    startStackCheckSweep(runtimeDb);
  }
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
  liveSavedSetting,
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
      const view = resolveBehaviorSettings({ stored: settings, env: process.env });
      applyLiveBehaviorSettings(view);
      applyRunEnvAllow(view);
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
    applyRunEnvAllow(view);
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
