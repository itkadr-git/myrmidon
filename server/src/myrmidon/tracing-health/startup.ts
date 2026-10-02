// server/src/myrmidon/tracing-health/startup.ts
//
// myrmidon(TRACING-HEALTH): the periodic sweep wiring. server/src/index.ts
// gets one marked call, `startTracingHealthSweep(db)`, next to
// startLitellmCostSweep, and one at shutdown; everything else lives here.
//
// Off (any core setting unset — the default): returns before anything is
// read; no timer, no query. On: one evaluation per company per interval
// (MYRMIDON_TRACING_INTERVAL_SEC, default 300, i.e. the 15-minute window is
// sampled every 5 minutes), each company swept independently — a failure of
// one company's sweep is logged and does not stop the others. The sweep is
// what keeps the operator attention signal fresh without anyone opening the
// status card: the card evaluation feeds the attention bridge, and the
// attention desk reads the bridge.

import { isNotNull } from "drizzle-orm";
import { companies, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { readTracingHealthSettings } from "./settings.js";
import { defaultTracingHealthDeps, tracingHealthService } from "./index.js";

export const TRACING_SWEEP_INTERVAL_ENV = "MYRMIDON_TRACING_INTERVAL_SEC";
const DEFAULT_SWEEP_INTERVAL_SEC = 300;
const MIN_SWEEP_INTERVAL_SEC = 60;
const MAX_SWEEP_INTERVAL_SEC = 86400;

export function readTracingSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[TRACING_SWEEP_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SWEEP_INTERVAL_SEC || value > MAX_SWEEP_INTERVAL_SEC) {
    return DEFAULT_SWEEP_INTERVAL_SEC * 1000;
  }
  return value * 1000;
}

let stopRunning: (() => void) | null = null;

/** Starts the sweep; returns the stop function. A no-op when disabled. */
export function startTracingHealthSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv } = {},
): () => void {
  const env = opts.env ?? process.env;
  const settings = readTracingHealthSettings(env);
  if (!settings.enabled) return () => {};
  const intervalMs = readTracingSweepIntervalMs(env);
  stopTracingHealthSweep();

  let sweeping = false;
  let stopped = false;
  const service = tracingHealthService(defaultTracingHealthDeps(db, env));

  const tick = async () => {
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const rows = await db
        .select({ id: companies.id })
        .from(companies)
        .where(isNotNull(companies.id));
      for (const row of rows) {
        try {
          await service.evaluate(row.id);
        } catch (err) {
          logger.warn({ err, companyId: row.id }, "tracing health sweep failed for one company");
        }
      }
    } catch (err) {
      logger.warn({ err }, "tracing health sweep failed to list companies");
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => logger.error({ err }, "tracing health sweep tick failed"));
  }, intervalMs);
  timer.unref?.();
  // The first evaluation runs at startup so the card and the operator signal
  // exist before anyone asks (the incident was exactly "nobody noticed").
  void tick().catch((err) => logger.error({ err }, "tracing health first sweep failed"));

  stopRunning = () => {
    stopped = true;
    clearInterval(timer);
  };
  return stopRunning;
}

/** Stops the sweep (idempotent). */
export function stopTracingHealthSweep(): void {
  stopRunning?.();
  stopRunning = null;
}
