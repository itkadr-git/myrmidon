// server/src/myrmidon/bot-containers/bot-disk-quota-runtime.ts
//
// myrmidon(1.6.1-BOT-DISK-C): the one runtime per server process, shared by the
// routes mounted in app.ts and the scheduler step called from the maintenance
// tick in index.ts. They must share it, so the endpoint reports the state of
// the sweep that actually runs — the same structure workspace-hygiene uses.

import type { Db } from "@paperclipai/db";
import { BOT_DISK_QUOTA_SETTINGS_KEY, normalizeBotDiskQuotaSettings } from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createBotDiskQuotaSweep, type BotDiskQuotaSweep, type BotDiskQuotaSweepResult } from "./bot-disk-quota-sweep.js";

export interface BotDiskQuotaRuntime {
  sweep: BotDiskQuotaSweep;
  /** Run one sweep and hand the work to the scheduler's tracker. */
  run(track: (work: Promise<unknown>) => void): void;
}

function createRuntime(db: Db): BotDiskQuotaRuntime {
  const settings = instanceSettingsService(db);
  const sweep = createBotDiskQuotaSweep({
    db,
    resolveSettings: async () => {
      const general = await settings.getGeneral();
      return normalizeBotDiskQuotaSettings(general[BOT_DISK_QUOTA_SETTINGS_KEY]);
    },
  });
  return {
    sweep,
    run: (track) => {
      track(
        sweep.sweep().catch((err) => {
          logger.error({ err }, "bot disk quota sweep failed");
        }),
      );
    },
  };
}

const runtimes = new WeakMap<Db, BotDiskQuotaRuntime>();

/** The runtime of this process for this database handle. */
export function botDiskQuotaRuntime(db: Db): BotDiskQuotaRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createRuntime(db);
  runtimes.set(db, runtime);
  return runtime;
}

/**
 * Scheduler step for the maintenance tick in server/src/index.ts: returns the
 * function the tick calls. One call measures one page of bot volumes; a
 * rejected sweep is logged, never thrown into the tick.
 */
export function createBotDiskQuotaScheduler(options: {
  db: Db;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const runtime = botDiskQuotaRuntime(options.db);
  return () => runtime.run(options.track);
}

export type { BotDiskQuotaSweepResult };
