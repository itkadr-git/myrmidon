// server/src/myrmidon/monitoring/alerts/sweep.ts
// myrmidon(1.6.6-ALERTS): the closed-entry sweep of the dedup registry. The
// registry lives in the instance_settings JSON column, so it needs a periodic
// prune or it grows forever: entries whose issue is closed and whose last
// update is older than the retention window are dropped. Maintenance pattern:
// the whole sweep lives here, server/src/index.ts gets one marked call.

import type { Db } from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import { createDbAlertDedupStore } from "./store.js";

export const ALERTS_SWEEP_INTERVAL_SEC_ENV = "MYRMIDON_ALERTS_SWEEP_INTERVAL_SEC";
export const ALERTS_RETENTION_DAYS_ENV = "MYRMIDON_ALERTS_RETENTION_DAYS";

export const DEFAULT_ALERTS_SWEEP_INTERVAL_SEC = 3600;
export const DEFAULT_ALERTS_RETENTION_DAYS = 14;

export interface AlertSweepSettings {
  intervalMs: number;
  retentionMs: number;
}

export function readAlertSweepSettings(env: NodeJS.ProcessEnv = process.env): AlertSweepSettings {
  const intervalSec = Number(env[ALERTS_SWEEP_INTERVAL_SEC_ENV]?.trim() || DEFAULT_ALERTS_SWEEP_INTERVAL_SEC);
  const retentionDays = Number(env[ALERTS_RETENTION_DAYS_ENV]?.trim() || DEFAULT_ALERTS_RETENTION_DAYS);
  return {
    intervalMs:
      Number.isInteger(intervalSec) && intervalSec > 0
        ? Math.min(intervalSec, 86_400) * 1000
        : DEFAULT_ALERTS_SWEEP_INTERVAL_SEC * 1000,
    retentionMs:
      Number.isFinite(retentionDays) && retentionDays > 0
        ? Math.min(retentionDays, 365) * 24 * 3600 * 1000
        : DEFAULT_ALERTS_RETENTION_DAYS * 24 * 3600 * 1000,
  };
}

let stopRunning: (() => void) | null = null;

/** Starts the sweep; returns the stop function. A no-op when disabled (interval 0). */
export function startAlertsSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date; log?: Pick<typeof logger, "info" | "warn" | "error"> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readAlertSweepSettings(env);
  const log = opts.log ?? logger;
  const now = opts.now ?? (() => new Date());
  const store = createDbAlertDedupStore(db);
  stopAlertsSweep();
  if (settings.intervalMs <= 0) return () => {};

  const timer = setInterval(() => {
    void (async () => {
      try {
        const removed = await store.sweepClosedOlderThan(now(), settings.retentionMs);
        if (removed > 0) log.info({ removed }, "monitoring alerts dedup sweep removed closed entries");
      } catch (err) {
        log.warn({ err }, "monitoring alerts dedup sweep failed");
      }
    })();
  }, settings.intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  stopRunning = stop;
  return stop;
}

export function stopAlertsSweep(): void {
  stopRunning?.();
  stopRunning = null;
}
