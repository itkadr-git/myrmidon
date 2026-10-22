// myrmidon(FEATURES): the periodic health pass that keeps the attention signal
// fresh.
//
// The first pass waits one minute, so the module sweeps have run at least once
// and a fresh start is not read as "no signal". Each pass evaluates the whole
// registry; the attention clock (attention.ts) is fed by that evaluation.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { sharedFeaturesService } from "./routes.js";

export const FEATURE_HEALTH_INTERVAL_ENV = "MYRMIDON_FEATURE_HEALTH_INTERVAL_SEC";
export const DEFAULT_FEATURE_HEALTH_INTERVAL_SEC = 300;
const MIN_FEATURE_HEALTH_INTERVAL_SEC = 60;
const MAX_FEATURE_HEALTH_INTERVAL_SEC = 3600;
const FIRST_PASS_DELAY_MS = 60_000;

/** The pass period; an unset, non-integer or out-of-range value falls back to 5 minutes. */
export function readFeatureHealthIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[FEATURE_HEALTH_INTERVAL_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_FEATURE_HEALTH_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (value < MIN_FEATURE_HEALTH_INTERVAL_SEC || value > MAX_FEATURE_HEALTH_INTERVAL_SEC) {
    return DEFAULT_FEATURE_HEALTH_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

let stopRunning: (() => void) | null = null;

/** Starts the pass; returns the stop function. A repeated call replaces the previous run. */
export function startFeatureHealthSweep(db: Db, env: Record<string, string | undefined> = process.env): () => void {
  stopFeatureHealthSweep();
  const service = sharedFeaturesService(db);
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await service.report({ fresh: true });
    } catch (err) {
      logger.warn({ err }, "feature health pass failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(() => void tick(), readFeatureHealthIntervalMs(env));
  const first = setTimeout(() => void tick(), FIRST_PASS_DELAY_MS);
  interval.unref?.();
  first.unref?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    clearTimeout(first);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

export function stopFeatureHealthSweep(): void {
  stopRunning?.();
}
