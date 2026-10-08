// server/src/myrmidon/data-retention/index.ts
//
// myrmidon(1.6.5-DB-RETENTION): the wiring point of the retention sweep.
//
// app.ts mounts `myrmidonDataRetentionRoutes` from here; the startup tick in
// index.ts calls `createDataRetentionScheduler`. One runtime per server
// process, created on demand and shared by the routes and the scheduler so
// both see the same sweep state. The state persists in
// `instance_settings.general.datastoreCare.retention.lastRun`, so a restart
// keeps the counters and the backup-gate flag.
//
// The "waiting for backup" activity line is throttled to at most once per
// hour per instance; the newest `data.retention_waiting_for_backup` line in
// the activity log anchors the throttle, the same anchor rule the workspace
// quota totals use.

import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DATA_RETENTION_WAITING_FOR_BACKUP_ACTION,
  DATA_RETENTION_SWEEP_THROTTLED_ACTION,
  type DataRetentionSettings,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  checkDataRetentionBackupGate,
  resolveDataRetentionBackupDir,
  resolveDataRetentionBackupPrefix,
} from "./backup-gate.js";
import { dataRetentionRoutes } from "./routes.js";
import { dataRetentionService, type DataRetentionService } from "./service.js";
import {
  readDataRetentionLastRun,
  readDataRetentionSettings,
  writeDataRetentionLastRun,
} from "./settings.js";
import { createDataRetentionSweep, type DataRetentionSweep } from "./sweep.js";

export { dataRetentionService } from "./service.js";
export type { DataRetentionService } from "./service.js";
export { createDataRetentionSweep } from "./sweep.js";
export type { DataRetentionSweep, DataRetentionSweepResult } from "./sweep.js";
export {
  checkDataRetentionBackupGate,
  resolveDataRetentionBackupDir,
  resolveDataRetentionBackupPrefix,
} from "./backup-gate.js";
export {
  readDataRetentionSettings,
  readDataRetentionLastRun,
  writeDataRetentionSettings,
  writeDataRetentionLastRun,
  preserveDataRetentionGeneralKey,
} from "./settings.js";

/** The "waiting for backup" activity line is written at most once per this window. */
export const DATA_RETENTION_WAITING_LOG_INTERVAL_MS = 60 * 60 * 1000;

export interface DataRetentionRuntime {
  sweep: DataRetentionSweep;
  service: DataRetentionService;
  /** Run one pass and hand the work to the scheduler's tracker. */
  run(track: (work: Promise<unknown>) => void): void;
}

export interface DataRetentionRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Test hook: override the backup dir resolution. */
  backupDir?: string;
}

function createRuntime(db: Db, options: DataRetentionRuntimeOptions = {}): DataRetentionRuntime {
  const env = options.env ?? process.env;
  const settings = instanceSettingsService(db);

  const sweep = createDataRetentionSweep({
    db,
    resolveSettings: (): Promise<DataRetentionSettings> => readDataRetentionSettings(settings),
    readLastRun: () => readDataRetentionLastRun(settings),
    writeLastRun: (lastRun) => writeDataRetentionLastRun(settings, lastRun),
    checkBackup: async () => {
      const backupDir = options.backupDir ?? resolveDataRetentionBackupDir();
      const prefix = resolveDataRetentionBackupPrefix(env);
      const checkedAt = new Date();
      const result = checkDataRetentionBackupGate({ backupDir, prefix, now: checkedAt });
      return { fresh: result.fresh, checkedAt };
    },
    logWaitingForBackup: async (details) => {
      // Throttled: the newest waiting line anchors the interval. Errors here
      // must never fail the pass — the persisted state already reports the
      // gate.
      try {
        const { activityLog } = await import("@paperclipai/db");
        const rows = await db
          .select({ createdAt: activityLog.createdAt })
          .from(activityLog)
          .where(eq(activityLog.action, DATA_RETENTION_WAITING_FOR_BACKUP_ACTION))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);
        const last = rows[0]?.createdAt;
        const lastAt = last instanceof Date ? last : last ? new Date(last) : null;
        if (lastAt && Date.now() - lastAt.getTime() < DATA_RETENTION_WAITING_LOG_INTERVAL_MS) {
          return;
        }
        const companyIds = await settings.listCompanyIds();
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "data-retention-sweep",
            action: DATA_RETENTION_WAITING_FOR_BACKUP_ACTION,
            entityType: "instance_settings",
            entityId: "datastoreCare.retention",
            details,
          });
        }
      } catch (err) {
        logger.warn({ err }, "data retention waiting-for-backup log failed");
      }
    },
    logThrottled: async (details) => {
      // One journal line per group whose batch hit the statement timeout —
      // the sweep itself never fails on a timeout, so this line is the only
      // trace. Errors here must never fail the pass.
      try {
        const companyIds = await settings.listCompanyIds();
        for (const companyId of companyIds) {
          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "data-retention-sweep",
            action: DATA_RETENTION_SWEEP_THROTTLED_ACTION,
            entityType: "instance_settings",
            entityId: "datastoreCare.retention",
            details,
          });
        }
      } catch (err) {
        logger.warn({ err }, "data retention sweep-throttled log failed");
      }
    },
  });

  const service = dataRetentionService({
    settings,
    listCompanyIds: () => settings.listCompanyIds(),
    logActivity: (entry) => logActivity(db, entry),
  });

  return {
    sweep,
    service,
    run: (track) => {
      track(
        sweep.sweep().catch((err) => {
          logger.error({ err }, "data retention sweep failed");
        }),
      );
    },
  };
}

const runtimes = new WeakMap<Db, DataRetentionRuntime>();

/** The runtime of this process for this database handle. */
export function dataRetentionRuntime(
  db: Db,
  options: DataRetentionRuntimeOptions = {},
): DataRetentionRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createRuntime(db, options);
  runtimes.set(db, runtime);
  return runtime;
}

/** Router for app.ts: GET/PATCH /api/myrmidon/data-retention. */
export function myrmidonDataRetentionRoutes(db: Db) {
  return dataRetentionRoutes(db, dataRetentionRuntime(db).service);
}

/**
 * Scheduler step for the tick in server/src/index.ts: returns the function
 * the tick calls. One call runs one pass; a rejected pass is logged, never
 * thrown into the tick.
 */
export function createDataRetentionScheduler(options: {
  db: Db;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const runtime = dataRetentionRuntime(options.db);
  return () => runtime.run(options.track);
}
