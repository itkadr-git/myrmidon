import type { Db } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../../services/index.js";
import { createDbAlertRecoveryIssuePort } from "./issues.js";
import { alertRecoveryRoutes } from "./routes.js";
import { createAlertRecoveryService, type AlertRecoveryService } from "./service.js";
import { createDbAlertRecoveryStore } from "./store.js";

/**
 * Entry point of alert recovery (myrmidon 1.6.6 MONITORING, part D).
 *
 * One runtime per server process, shared by the routes mounted in
 * `server/src/app.ts` and the tick step registered in `server/src/index.ts`:
 * they must see the same journal. Startup reads nothing; the knobs are read at
 * the top of every ingest and every sweep, so a settings change takes effect
 * without a restart, and a restart keeps whatever the settings row holds.
 */

export { createAlertRecoveryService, alertRecoveryCloseDueAt } from "./service.js";
export type {
  AlertRecoveryActor,
  AlertRecoveryIngestResult,
  AlertRecoveryIssuePort,
  AlertRecoveryService,
  AlertRecoveryServiceDeps,
  AlertRecoverySweepResult,
  AlertRecoveryView,
} from "./service.js";
export { createAlertRecoveryStore, createDbAlertRecoveryStore } from "./store.js";
export type { AlertRecoveryStore } from "./store.js";
export { createDbAlertRecoveryIssuePort } from "./issues.js";
export { alertRecoveryRunbooks, selectAlertRecoveryRunbook, renderAlertRecoverySection } from "./runbook.js";
export type { AlertRecoveryRunbook } from "./runbook.js";
export {
  alertRecoveryIssueTitle,
  alertRecoveryPriority,
  dueAlertRecoveryRecords,
  planAlertRecoveryEvent,
} from "./domain.js";
export type { AlertRecoveryAlert, AlertRecoveryPlan, AlertRecoveryPlanKind } from "./domain.js";
export { alertRecoveryRoutes } from "./routes.js";

export interface AlertRecoveryRuntime {
  service: AlertRecoveryService;
  /** Run one sweep pass — the automatic close and the pruning — and track it. */
  run(track: (work: Promise<unknown>) => void): void;
}

export interface AlertRecoveryRuntimeOptions {
  env?: Record<string, string | undefined>;
}

function createRuntime(db: Db, options: AlertRecoveryRuntimeOptions = {}): AlertRecoveryRuntime {
  const env = options.env ?? process.env;
  const settings = instanceSettingsService(db);
  const store = createDbAlertRecoveryStore(db, env);
  const service = createAlertRecoveryService({
    store,
    issues: createDbAlertRecoveryIssuePort(db),
    logActivity: (entry) => logActivity(db, entry),
    listCompanyIds: () => settings.listCompanyIds(),
    log: (event, details) => logger.info(details, event),
  });
  return {
    service,
    run: (track) => {
      track(
        service.sweep().catch((err) => {
          logger.error({ err }, "alert recovery sweep failed");
        }),
      );
    },
  };
}

const runtimes = new WeakMap<Db, AlertRecoveryRuntime>();

/** The runtime of this process for this database handle. */
export function alertRecoveryRuntime(db: Db, options: AlertRecoveryRuntimeOptions = {}): AlertRecoveryRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createRuntime(db, options);
  runtimes.set(db, runtime);
  return runtime;
}

/** Router for app.ts: GET/PATCH /api/myrmidon/monitoring/alert-recovery and the event intake. */
export function myrmidonAlertRecoveryRoutes(db: Db) {
  return alertRecoveryRoutes(db, alertRecoveryRuntime(db).service);
}

/**
 * Scheduler step for the tick in server/src/index.ts: returns the function the
 * tick calls. Each call runs one sweep; a rejected sweep is logged, never
 * thrown into the tick.
 */
export function createAlertRecoveryScheduler(options: {
  db: Db;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const runtime = alertRecoveryRuntime(options.db);
  return () => runtime.run(options.track);
}