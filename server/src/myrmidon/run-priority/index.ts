// Live run queue priority (myrmidon 1.6.5, RUN-PRIORITY A) entry point.
//
// Startup: read the stored settings once and put them in force before the
// scheduler starts runs. After that every settings write applies itself
// (see service.ts), so changed weights reach the queue without a restart.

import type { Db } from "@myrmidon/db";
import { assertRunPriorityQueueInvariant } from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../../services/index.js";
import { scheduleQueuedResweep } from "../run-admission.js";
import { runPriorityRoutes } from "./routes.js";
import { runPriorityService, type RunPriorityServiceDeps } from "./service.js";
import { advanceFocusDeferredRuns, applyStoredRunPriority, startRunPriorityRefresh } from "./sync.js";

export {
  applyRunPrioritySettings,
  currentRunPrioritySettings,
  resetRunPriorityForTests,
  resolveRunPriority,
  type RunPriorityView,
} from "./state.js";
export {
  runPriorityService,
  RUN_PRIORITY_ACTION,
} from "./service.js";
export type {
  RunPriorityActor,
  RunPriorityAuditEntry,
  RunPriorityService,
  RunPriorityServiceDeps,
} from "./service.js";
export {
  compareRunsByPriority,
  runMatchesCurrentRelease,
  sortByRunPriority,
  type PriorityScoredRun,
} from "./scoring.js";

export interface RunPriorityBus {
  publish(channel: "settings_changed", payload: unknown): Promise<void>;
}

function defaultDeps(db: Db, bus: RunPriorityBus | null = null): RunPriorityServiceDeps {
  const heartbeat = heartbeatService(db);
  return {
    settings: instanceSettingsService(db),
    listCompanyIds: () => instanceSettingsService(db).listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
    applyStored: () => applyStoredRunPriority(db),
    advanceDeferredRuns: () => advanceFocusDeferredRuns(db),
    publishChanged: bus ? () => bus.publish("settings_changed", { changedKeys: ["runPriority"] }) : undefined,
    scheduleResweep: () =>
      scheduleQueuedResweep(() =>
        heartbeat.resumeQueuedRuns().catch((err) => {
          logger.error({ err }, "queued run resweep after a run priority change failed");
        }),
      ),
  };
}

/** Router for app.ts: GET/PATCH /api/myrmidon/run-priority. */
export function myrmidonRunPriorityRoutes(db: Db, bus: RunPriorityBus | null = null) {
  return runPriorityRoutes(db, runPriorityService(db, defaultDeps(db, bus)));
}

/**
 * Startup: put the stored run priority settings in force. A failed read must
 * not stop the server: the sweeps fall back to the environment and defaults,
 * which is the pre-feature behaviour (env off by default means plain FIFO).
 */
export async function startRunPriority(db: Db): Promise<void> {
  try {
    const view = await runPriorityService(db, defaultDeps(db)).read();
    assertRunPriorityQueueInvariant(view.settings);
    await applyStoredRunPriority(db);
    startRunPriorityRefresh(db);
    logger.info(
      { settings: view.settings, source: view.source },
      "run queue priority settings at startup",
    );
  } catch (err) {
    logger.error(
      { err },
      "failed to read the stored run priority settings; the environment values stay in force",
    );
  }
}
