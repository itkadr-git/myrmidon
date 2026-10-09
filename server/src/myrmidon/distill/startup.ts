// server/src/myrmidon/distill/startup.ts
//
// myrmidon(1.6.6 KNOWLEDGE-2.0 K-5): where the distiller gets started. The
// sweep pattern is the foraging one (1.6-FORAGING): a timer, a live settings
// read on every tick (a change from the interface applies without a restart),
// one pass per company, a no-op when the switch is off. The pass is heavy —
// a daily rhythm by default — so the tick arms on `intervalSec` and the very
// first pass waits for the interval rather than firing at boot.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createKnowledgeModule } from "../knowledge/service.js";
import { createDistillGatewayCall, type DistillModelCall } from "./model.js";
import { runDistillPass } from "./service.js";
import { resolveDistillSettings } from "./settings.js";
import { listCompanyIds } from "./raw.js";
import { secretService } from "../../services/secrets.js";

const log = logger.child({ module: "knowledge-distill" });

let stopRunning: (() => void) | null = null;

export interface DistillSweepOptions {
  /** Inject the model call (tests). The startup resolves the gateway from env+secret. */
  model?: (companyId: string) => Promise<DistillModelCall | null>;
  /** Env override for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Starts the distiller sweep. Returns a stop function; a second call replaces
 * the first. Disabled by default — the pass runs only when the instance
 * setting (or MYRMIDON_DISTILL_ENABLED=1) says so.
 */
export function startDistillSweep(db: Db, options: DistillSweepOptions = {}): () => void {
  if (stopRunning) stopRunning();
  const env = options.env ?? process.env;
  const settings = instanceSettingsService(db);
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const resolveModel: (companyId: string) => Promise<DistillModelCall | null> =
    options.model ??
    (async (companyId) => {
      const resolved = resolveDistillSettings((await settings.getGeneral()) as unknown as Record<string, unknown>, env);
      if (!resolved.gatewayUrl || !resolved.keySecret) return null;
      const secrets = secretService(db);
      const row = await secrets.getByName(companyId, resolved.keySecret);
      if (!row) return null;
      const apiKey = await secrets.resolveSecretValue(companyId, row.id, "latest");
      if (!apiKey) return null;
      return createDistillGatewayCall({ fetch, apiKey, baseUrl: resolved.gatewayUrl, model: resolved.settings.model });
    });

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const resolved = resolveDistillSettings((await settings.getGeneral()) as unknown as Record<string, unknown>, env);
      if (!resolved.settings.enabled) return;
      // A changed interval re-arms the timer on the next tick.
      if (timer && (timer as unknown as { _idleTimeout?: number })._idleTimeout !== resolved.intervalMs) {
        clearInterval(timer);
        timer = setInterval(() => void tick(), resolved.intervalMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      const companyIds = await listCompanyIds(db);
      for (const companyId of companyIds) {
        try {
          const model = await resolveModel(companyId);
          if (!model) {
            log.info({ companyId }, "distiller: no gateway/secret configured for this company; skipping pass");
            continue;
          }
          const knowledge = createKnowledgeModule(db, companyId);
          const report = await runDistillPass({ db, knowledge, model, settings: resolved });
          log.info(report, "distiller pass completed");
        } catch (err) {
          log.warn({ err, companyId }, "distiller pass failed for one company");
        }
      }
    } catch (err) {
      log.error({ err }, "distiller sweep tick failed");
    } finally {
      running = false;
    }
  };

  const arm = (intervalMs: number) => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void tick(), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  // The distiller is a slow rhythm; the first pass waits for the interval
  // instead of firing at boot. When the switch is off, arm the cheap polling
  // tick so a later switch-on from the interface is picked up without restart.
  void (async () => {
    try {
      const resolved = resolveDistillSettings((await settings.getGeneral()) as unknown as Record<string, unknown>, env);
      if (stopped) return;
      arm(resolved.settings.enabled ? resolved.intervalMs : 60_000);
    } catch {
      if (!stopped) arm(60_000);
    }
  })();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (stopRunning === stop) stopRunning = null;
  };
  stopRunning = stop;
  return stop;
}

/** Stops the sweep started by `startDistillSweep`; a no-op when none runs. */
export function stopDistillSweep(): void {
  stopRunning?.();
}
