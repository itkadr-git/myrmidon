// myrmidon(DBC-4): wiring of the datastore-care module.
//
// The board's own PostgreSQL is reached through the connection the board
// already has (`db`), so the implicit target needs no configuration: the
// collector and the live probe both run on that connection, and the target's
// `dbId` is read from `pg_database` on the first collection.

import { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import { BOARD_CONNECTION_REF, implicitDatastoreTargets, type DatastoreTarget } from "./domain.js";
import { readDatastoreCareSettings, type DatastoreCareSettings } from "./settings.js";
import {
  collectPostgresSnapshot,
  drizzleQueryPort,
  toNumber,
  toStringValue,
} from "./collectors/postgres.js";
import { createDatastoreCareStore, type DatastoreCareStore } from "./store.js";
import {
  createDatastoreCareService,
  type DatastoreCareService,
  type DatastoreTargetProbe,
} from "./service.js";
import { datastoreCareRoutes } from "./routes.js";
import { createDatastoreCareJob, type DatastoreCareJob } from "./startup.js";
// myrmidon(1.6.5-DBC1): retention runtime (same module index, distinct names).
import {
  createDatastoreCareRetentionRuntime,
  type DatastoreCareRetentionRuntime,
} from "./retention/service.js";

/** The runtime of the module: what the routes, the job and the tests share. */
export interface DatastoreCareRuntime {
  settings: DatastoreCareSettings;
  store: DatastoreCareStore;
  service: DatastoreCareService;
}

/** Everything the runtime needs to be built; all replaceable in tests. */
export interface DatastoreCareRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Live probe: the size the acceptance criteria compare with pg_database_size. */
async function probeBoardTarget(
  db: Db,
  target: DatastoreTarget,
): Promise<DatastoreTargetProbe> {
  const port = drizzleQueryPort(db, target.connectionRef || BOARD_CONNECTION_REF);
  const rows = await port.rows(sql`
    SELECT current_database() AS database,
           (SELECT oid::bigint FROM pg_database WHERE datname = current_database()) AS dbid,
           version() AS server_version,
           pg_database_size(current_database()) AS database_bytes
  `);
  const row = rows[0] ?? {};
  return {
    database: toStringValue(row.database, "unknown"),
    dbId: toNumber(row.dbid, 0) || null,
    serverVersion: toStringValue(row.server_version),
    databaseBytes: toNumber(row.database_bytes),
  };
}

/** Builds the runtime of the module on top of a database handle. */
export function createDatastoreCareRuntime(
  db: Db,
  options: DatastoreCareRuntimeOptions = {},
): DatastoreCareRuntime {
  const env = options.env ?? process.env;
  const settings = readDatastoreCareSettings(env);
  const store = createDatastoreCareStore(db);

  const service = createDatastoreCareService({
    store,
    now: options.now ?? (() => new Date()),
    settings,
    collect: (target, now) => collectSnapshotWith(db, target, now, settings),
    probe: (target) => probeBoardTarget(db, target),
  });

  return { settings, store, service };
}

/** Collects a full snapshot of a target with the module's settings. */
function collectSnapshotWith(
  db: Db,
  target: DatastoreTarget,
  now: Date,
  settings: DatastoreCareSettings,
) {
  return collectPostgresSnapshot(
    {
      target,
      dbId: null,
      now,
      topQueries: settings.topQueries,
      backupDir: settings.backupDir,
      optionalMetrics: settings.optionalMetrics,
    },
    { connection: drizzleQueryPort(db, target.connectionRef || BOARD_CONNECTION_REF) },
  );
}

/** The routes of the module, as `app.ts` mounts them. */
export function myrmidonDatastoreCareRoutes(
  db: Db,
  options: DatastoreCareRuntimeOptions = {},
): Router {
  return datastoreCareRoutes({
    service: createDatastoreCareRuntime(db, options).service,
    env: options.env ?? process.env,
  });
}

let job: DatastoreCareJob | null = null;

/**
 * Starts the hourly collection (and its 90-day retention).
 *
 * A no-op unless `MYRMIDON_DATASTORE_CARE_ENABLED` is on, which is the default:
 * the module is the automated part of the "database audit before the release"
 * decision, so it runs unless an operator explicitly switches it off.
 */
export function startDatastoreCare(
  db: Db,
  options: DatastoreCareRuntimeOptions = {},
): DatastoreCareJob | null {
  stopDatastoreCare();
  const runtime = createDatastoreCareRuntime(db, options);
  if (!runtime.settings.enabled) return null;
  job = createDatastoreCareJob({
    service: runtime.service,
    store: runtime.store,
    settings: runtime.settings,
    targets: () => implicitDatastoreTargets(),
    now: options.now,
    log: options.log,
  });
  job.start();
  return job;
}

/** Stops the hourly collection. */
export function stopDatastoreCare(): void {
  job?.stop();
  job = null;
}

/** The job in force, for the shutdown path and the tests. */
export function datastoreCareJob(): DatastoreCareJob | null {
  return job;
}

// myrmidon(1.6.5-DBC1): the retention wiring lives in the same module index.
//
// The maintenance module calls `startDatastoreCareRetention` from its sweep
// tick, which runs under the maintenance gate; one runtime per server
// process, created lazily and shared, so concurrent ticks join the pass
// already running. The pass state persists in
// `instance_settings.general.datastoreCare.retention.contextLastRun`, so a restart
// keeps the counters and the backup-gate flag.

export {
  readRetentionSettings,
  readRetentionLastRun,
  writeRetentionSettings,
  writeRetentionLastRun,
  preserveDatastoreCareGeneralKey,
  resolveRetentionSettings,
  HEARTBEAT_RUN_CONTEXT_RETENTION_DAYS_ENV,
} from "./retention/settings.js";
export {
  checkBackupGate,
  resolveBackupDir,
  resolveBackupFilePrefix,
} from "./retention/backup-gate.js";
export {
  compactContextPass,
  compactContextSnapshot,
  CONTEXT_COMPACT_KEYS,
  CONTEXT_COMPACT_BATCH_SIZE,
} from "./retention/compact.js";
export { datastoreCareRetentionRoutes } from "./retention/routes.js";
export type { DatastoreCareRetentionRuntime } from "./retention/service.js";

let runtime: DatastoreCareRetentionRuntime | null = null;
let runtimeDb: Db | null = null;

function getRuntime(db: Db): DatastoreCareRetentionRuntime {
  if (!runtime || runtimeDb !== db) {
    runtime = createDatastoreCareRetentionRuntime(db);
    runtimeDb = db;
  }
  return runtime;
}

/**
 * The sweep-tick entry: called once per maintenance tick, cheap when idle
 * (the pass is gated on the maintenance window, the settings, and the backup
 * precondition). Never throws — a failed pass logs and waits for the tick.
 */
export function runDatastoreCareRetentionTick(db: Db): void {
  void getRuntime(db)
    .runOnce()
    .catch(() => {
      // The runtime already logs pass failures; the tick must not reject.
    });
}
