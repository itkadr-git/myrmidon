// server/src/myrmidon/foraging/startup.ts
//
// myrmidon(1.6-FORAGE): the periodic sweep wiring. server/src/index.ts gets one
// marked call, `startForagingSweep(db)`, and one at shutdown; everything else
// lives here.
//
// Off by default: without the switch on (the instance settings row, or the
// environment variable before any row was saved) the function returns before
// anything is read — no timer, no query. On: one pass per company per interval,
// each company swept independently, so one company's failure is logged and does
// not stop the others, and the next tick tries again. A pass that overlaps the
// previous one waits: the timer skips a tick whose pass is still running instead
// of stacking.
//
// 1.6.1 (FORAGING-LIMITS-UI): no restart for anything the interface changes.
// The tick re-resolves the effective settings BEFORE every pass:
//   - the switch off stops the sweep within one interval (the timer keeps
//     ticking cheaply — one settings read, no pass);
//   - the switch on after an env-only start arms the pass without a restart;
//   - a changed interval is picked up by resetting the timer.
// The settings row is read through `instanceSettingsService` on every tick, so
// the value saved in the interface is in force with the next pass, never later
// than one interval — and the manual `POST …/foraging/sweep` trigger applies it
// immediately.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { resolveForagingEffectiveSettings } from "./settings.js";
import { foragingWiring } from "./index.js";

export interface ForagingSweepPorts {
  listCompanyIds(db: Db): Promise<string[]>;
  now(): Date;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
    error(fields: object, message: string): void;
  };
}

let stopRunning: (() => void) | null = null;

/** Starts the sweep; returns the stop function. A no-op when disabled. */
export function startForagingSweep(
  db: Db,
  opts: { env?: NodeJS.ProcessEnv; ports?: Partial<ForagingSweepPorts> } = {},
): () => void {
  const env = opts.env ?? process.env;
  const log = opts.ports?.log ?? logger;
  const settings = instanceSettingsService(db);
  const wiring = foragingWiring(db, env);
  stopForagingSweep();

  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      // 1.6.1: the switch is live. A settings change made in the interface is
      // read here, before any pass is considered — no restart, no re-arm.
      let enabled: boolean;
      let intervalMs: number;
      try {
        const effective = await resolveForagingEffectiveSettings(settings, env);
        enabled = effective.settings.enabled;
        intervalMs = effective.intervalMs;
      } catch (err) {
        log.warn({ err }, "foraging: settings resolve failed; skipping this tick");
        return;
      }
      if (!enabled) return;
      // A changed interval re-arms the timer on the next tick.
      if (timer && (timer as unknown as { _idleTimeout?: number })._idleTimeout !== intervalMs) {
        clearInterval(timer);
        timer = setInterval(() => {
          void tick();
        }, intervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      const companyIds = opts.ports?.listCompanyIds
        ? await opts.ports.listCompanyIds(db)
        : (await wiring.store.listCompanyIds());
      for (const companyId of companyIds) {
        try {
          await wiring.service.runPass(companyId);
        } catch (err) {
          log.warn({ err, companyId }, "foraging pass failed for one company");
        }
      }
    } catch (err) {
      log.error({ err }, "foraging sweep tick failed");
    } finally {
      running = false;
    }
  };

  const arm = (intervalMs: number) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  // The initial arm: the env-only view is enough for the first interval; the
  // tick itself re-reads the settings row and re-arms if the value changed.
  const initial = resolveForagingEffectiveSettings(settings, env).catch(() => null);
  void initial.then((effective) => {
    if (stopped) return;
    if (effective?.settings.enabled) {
      arm(effective.intervalMs);
      void tick();
    } else {
      // Switched off at start: arm the cheap polling tick so a later
      // switch-on from the interface is picked up without a restart.
      arm(60_000);
    }
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the sweep started by `startForagingSweep`; a no-op when none runs. */
export function stopForagingSweep(): void {
  stopRunning?.();
}
