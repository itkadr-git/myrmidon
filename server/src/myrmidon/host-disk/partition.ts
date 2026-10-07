import {
  partitionAlertLevel,
  partitionPressureLevel,
  resolveWsBotDiskPartitionSettings,
  type WsBotDiskPartitionSettings,
  type WsDiskPressureLevel,
} from "@paperclipai/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/index.js";
import type { Db } from "@paperclipai/db";
import type { BotPartitionUsage, DockergateDiskClient } from "./dockergate.js";

/**
 * Bot-partition threshold state (myrmidon 1.6.5 BOT-DISK-H, part H10).
 *
 * One process-wide runtime. The host-disk sweep calls `updateFromPartition`
 * with the dockergate measurement; the attention feed reads the last result
 * for the `host_disk_alert` card; the desired-state stub reads it for the
 * `pressure` block; `notifyCritical` sends the owner a Telegram card through
 * the existing telegram-notify outbox.
 *
 * Dedup contract: a warn/critical card refreshes the same feed row while the
 * partition stays over its threshold (the feed dedup key is constant), and
 * the owner Telegram message is sent at most once per crossing of the
 * critical threshold — the latch resets only after the partition drops below
 * the warn threshold again.
 */

export interface BotPartitionThresholdState {
  /** Last dockergate measurement; null = the partition was never measured. */
  partition: BotPartitionUsage | null;
  /** Thresholds the last evaluation used. */
  settings: WsBotDiskPartitionSettings | null;
  /** Alert level of the last evaluation: none/warn/critical. */
  alertLevel: "none" | "warn" | "critical" | null;
  /** Pressure level the desired state reports: none/hard. */
  pressureLevel: WsDiskPressureLevel;
  /** True while a critical notification has been sent and not yet reset. */
  criticalNotified: boolean;
  /** ISO timestamp of the last evaluation. */
  evaluatedAt: string | null;
}

export interface BotPartitionNotifyInput {
  usage: BotPartitionUsage;
  settings: WsBotDiskPartitionSettings;
  level: "warn" | "critical";
}

export interface BotPartitionThresholdDeps {
  /** Telegram card enqueue; injected so tests need no chat tables. */
  notifyOwner?: (input: BotPartitionNotifyInput) => Promise<void>;
  /**
   * Settings reader; injected so tests need no database. Production wiring
   * passes nothing and the runtime reads `instance_settings.general.botDisk`.
   */
  getBotDiskSettings?: () => Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface BotPartitionThresholdRuntime {
  /** Record a fresh measurement and evaluate the thresholds. */
  updateFromPartition(usage: BotPartitionUsage): Promise<BotPartitionThresholdState>;
  /** Mark the partition as unmeasured (dockergate down): the state resets to the previous behaviour. */
  markUnmeasured(): BotPartitionThresholdState;
  /** The current snapshot; the attention feed and the desired-state stub read it. */
  current(): BotPartitionThresholdState;
  /** The thresholds the sweep resolved this tick (settings/env/default). */
  resolveThresholds(): Promise<WsBotDiskPartitionSettings>;
}

const EMPTY_STATE: BotPartitionThresholdState = {
  partition: null,
  settings: null,
  alertLevel: null,
  pressureLevel: "none",
  criticalNotified: false,
  evaluatedAt: null,
};

export function createBotPartitionThresholdRuntime(
  db: Db | null,
  deps: BotPartitionThresholdDeps = {},
): BotPartitionThresholdRuntime {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const settingsService = db ? instanceSettingsService(db) : null;
  let state: BotPartitionThresholdState = { ...EMPTY_STATE };

  async function resolveThresholds(): Promise<WsBotDiskPartitionSettings> {
    const botDisk = deps.getBotDiskSettings
      ? await deps.getBotDiskSettings()
      : ((await settingsService!.getGeneral()) as unknown as Record<string, unknown>).botDisk;
    return resolveWsBotDiskPartitionSettings({ stored: botDisk, env }).settings;
  }

  async function updateFromPartition(usage: BotPartitionUsage): Promise<BotPartitionThresholdState> {
    const settings = await resolveThresholds();
    const alert = partitionAlertLevel(usage.usedPercent, settings);
    const pressure = partitionPressureLevel(usage.usedPercent, settings);
    state = {
      partition: usage,
      settings,
      alertLevel: alert,
      pressureLevel: pressure,
      // The latch holds until the partition drops below the warn threshold;
      // a warn->critical crossing while still over the warn threshold keeps
      // the previous warn notification but arms a fresh critical one.
      criticalNotified:
        usage.usedPercent < settings.partitionThresholdPercent
          ? false
          : state.criticalNotified && alert === "critical",
      evaluatedAt: now().toISOString(),
    };
    if (alert === "critical" && !state.criticalNotified && deps.notifyOwner) {
      try {
        await deps.notifyOwner({ usage, settings, level: "critical" });
        state = { ...state, criticalNotified: true };
      } catch (err) {
        logger.error({ err }, "bot partition critical notification failed");
      }
    }
    return state;
  }

  function markUnmeasured(): BotPartitionThresholdState {
    state = { ...EMPTY_STATE, evaluatedAt: now().toISOString() };
    return state;
  }

  return {
    updateFromPartition,
    markUnmeasured,
    current: () => state,
    resolveThresholds,
  };
}

const runtimes = new WeakMap<Db, BotPartitionThresholdRuntime>();

/** The process-wide runtime; the sweep, the attention feed and the desired state share it. */
export function botPartitionThresholdRuntime(
  db: Db,
  deps: BotPartitionThresholdDeps = {},
): BotPartitionThresholdRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createBotPartitionThresholdRuntime(db, deps);
  runtimes.set(db, runtime);
  return runtime;
}

/** Test hook: drop the cached runtime so each test gets a fresh latch. */
export function resetBotPartitionThresholdRuntime(db: Db): void {
  runtimes.delete(db);
}

/** Standalone runtime for tests (no WeakMap, no db). */
export function botPartitionThresholdRuntimeForTest(
  deps: BotPartitionThresholdDeps = {},
): BotPartitionThresholdRuntime {
  return createBotPartitionThresholdRuntime(null, deps);
}
