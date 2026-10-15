// server/src/myrmidon/datastore-care/startup.ts
//
// myrmidon(DBC-4): the hourly collection and the retention of the module.
//
// One pass, per target: collect a snapshot, then delete everything older than
// the module's retention (90 days by default). The pass never overlaps itself
// and never throws into the timer — a failing collection leaves the previous
// snapshot in place and is reported in the run result.
//
// Scheduled on the interval, and once at startup when the newest snapshot is
// already older than the interval: an instance that restarts often still ends
// up with the 24 snapshots a day the project asks for, and an instance that
// restarts every minute does not collect on every boot.

import { prettyBytes } from "./domain.js";
import type { DatastoreTarget } from "./domain.js";
import type { DatastoreCareService } from "./service.js";
import type { DatastoreCareStore } from "./store.js";
import type { DatastoreCareSettings } from "./settings.js";

/** What one pass over all targets did. */
export interface DatastoreCareJobRun {
  reason: string;
  startedAt: string;
  finishedAt: string;
  snapshots: { key: string; id: string; sizeBytes: number }[];
  prunedSnapshots: number;
  prunedAuditReports: number;
  errors: { key: string; message: string }[];
}

/** Dependencies of the job. */
export interface DatastoreCareJobDeps {
  service: DatastoreCareService;
  store: DatastoreCareStore;
  settings: DatastoreCareSettings;
  targets: () => readonly DatastoreTarget[];
  now?: () => Date;
  log?: (message: string) => void;
}

/** The job handle. */
export interface DatastoreCareJob {
  readonly intervalMs: number;
  start(): void;
  stop(): void;
  /** One pass; `null` when a pass is already running. */
  runOnce(reason: string): Promise<DatastoreCareJobRun | null>;
  /** Whether a pass is in flight (used by the tests and the status endpoint). */
  isRunning(): boolean;
}

/** Builds the job; calling `start()` schedules it. */
export function createDatastoreCareJob(deps: DatastoreCareJobDeps): DatastoreCareJob {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function runOnce(reason: string): Promise<DatastoreCareJobRun | null> {
    if (running) return null;
    running = true;
    const startedAt = now().toISOString();
    const run: DatastoreCareJobRun = {
      reason,
      startedAt,
      finishedAt: startedAt,
      snapshots: [],
      prunedSnapshots: 0,
      prunedAuditReports: 0,
      errors: [],
    };

    try {
      for (const target of deps.targets()) {
        try {
          const { snapshot } = await deps.service.captureSnapshot(target.key);
          run.snapshots.push({ key: target.key, id: snapshot.id, sizeBytes: snapshot.sizeBytes });
          log(
            `datastore-care: snapshot ${target.key} ${prettyBytes(snapshot.sizeBytes)} (${snapshot.id})`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          run.errors.push({ key: target.key, message });
          log(`datastore-care: snapshot ${target.key} failed: ${message}`);
        }
      }

      // Retention: snapshots and reports carry the module's own 90 days. The
      // prune runs even when a collection failed — old rows leave either way.
      const cutoff = new Date(now().getTime() - deps.settings.retentionMs);
      try {
        run.prunedSnapshots = await deps.store.pruneSnapshotsBefore(cutoff);
        run.prunedAuditReports = await deps.store.pruneAuditReportsBefore(cutoff);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.errors.push({ key: "retention", message });
        log(`datastore-care: retention failed: ${message}`);
      }
    } finally {
      run.finishedAt = now().toISOString();
      running = false;
    }

    return run;
  }

  return {
    intervalMs: deps.settings.intervalMs,

    isRunning(): boolean {
      return running;
    },

    async runOnce(reason: string) {
      return runOnce(reason);
    },

    start(): void {
      if (timer || !deps.settings.enabled) return;
      timer = setInterval(() => {
        void runOnce("hourly");
      }, deps.settings.intervalMs);
      timer.unref?.();

      // Catch up right away when the newest snapshot is already stale: after a
      // deploy or a restart the hourly cadence would otherwise be delayed by a
      // full interval.
      void (async () => {
        const target = deps.targets()[0];
        if (!target) return;
        try {
          const latest = await deps.store.latestSnapshot(target.key);
          const stale =
            !latest || now().getTime() - new Date(latest.capturedAt).getTime() >= deps.settings.intervalMs;
          if (stale) await runOnce("startup");
        } catch (error) {
          log(
            `datastore-care: startup catch-up skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      })();
    },

    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}