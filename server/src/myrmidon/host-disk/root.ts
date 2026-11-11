import {
  rootDiskAlertLevel,
  resolveWsRootDiskSettings,
  type WsRootDiskSettings,
} from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/index.js";
import type { Db } from "@myrmidon/db";
import type { HostRootUsage } from "./dockergate.js";

/**
 * Host-root threshold state (myrmidon 1.6.8 OPE-12697, DISK-ALERT).
 *
 * The root filesystem of the board host is measured by dockergate (the
 * `root` field of `GET /myrmidon/disk`, contract C5) — the board process
 * sees only its own volume, a statfs inside the container says nothing
 * about the host's `/`. The host-disk sweep feeds every measurement into
 * this runtime; the attention feed reads the last result for the
 * `host_disk_alert` card; `notify` sends the owner a Telegram card through
 * the same outbox the bot-partition critical path uses.
 *
 * Thresholds (contract in `myrmidon-host-root-disk.ts`): warn > 85 %,
 * critical (high-level alarm) > 90 %, both stored in
 * `instance_settings.general.botDisk` next to the bot-partition keys.
 *
 * Dedup contract (the OPE-12697 acceptance rule): a Telegram notification
 * repeats at most once per hour per level. The runtime latches per level;
 * a level re-arms only after the usage drops below the warn threshold.
 * Unlike the bot-partition latch (exactly once per crossing), an hour of
 * sustained 90 %+ keeps reminding the owner — the acceptance test pins
 * "a repeat within the hour is not sent".
 */

export interface HostRootThresholdState {
  /** Last dockergate measurement of `/`; null = never measured. */
  root: HostRootUsage | null;
  /** Thresholds the last evaluation used. */
  settings: WsRootDiskSettings | null;
  /** Alert level of the last evaluation: none/warn/critical. */
  alertLevel: "none" | "warn" | "critical" | null;
  /** ISO timestamp of the last evaluation. */
  evaluatedAt: string | null;
}

export interface HostRootNotifyInput {
  usage: HostRootUsage;
  settings: WsRootDiskSettings;
  level: "warn" | "critical";
}

export interface HostRootThresholdDeps {
  /** Telegram card enqueue; injected so tests need no chat tables. */
  notify?: (input: HostRootNotifyInput) => Promise<void>;
  /** Repeat window of one level: the acceptance rule is once per hour. */
  repeatIntervalMs?: number;
  /**
   * Settings reader; injected so tests need no database. Production wiring
   * passes nothing and the runtime reads `instance_settings.general.botDisk`.
   */
  getBotDiskSettings?: () => Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface HostRootThresholdRuntime {
  /** Record a fresh measurement and evaluate the thresholds. */
  updateFromRoot(usage: HostRootUsage): Promise<HostRootThresholdState>;
  /** Mark the root as unmeasured (dockergate down): the state resets. */
  markUnmeasured(): HostRootThresholdState;
  /** The current snapshot; the attention feed reads it. */
  current(): HostRootThresholdState;
  /** The thresholds the sweep resolved this tick (settings/env/default). */
  resolveThresholds(): Promise<WsRootDiskSettings>;
}

/** A replayed or stale gate answer is not evidence about the disk now. */
export const HOST_ROOT_SAMPLE_MAX_AGE_MS = 5 * 60 * 1000;

/** The acceptance rule: a signal repeats at most once per hour per level. */
export const HOST_ROOT_REPEAT_INTERVAL_MS = 60 * 60 * 1000;

const EMPTY_STATE: HostRootThresholdState = {
  root: null,
  settings: null,
  alertLevel: null,
  evaluatedAt: null,
};

export function createHostRootThresholdRuntime(
  db: Db | null,
  deps: HostRootThresholdDeps = {},
): HostRootThresholdRuntime {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const repeatIntervalMs = deps.repeatIntervalMs ?? HOST_ROOT_REPEAT_INTERVAL_MS;
  const settingsService = db ? instanceSettingsService(db) : null;
  let state: HostRootThresholdState = { ...EMPTY_STATE };
  // Per-level latch: the level and the wall clock of its last notification.
  // `null` = never notified at this level (the first crossing fires at once).
  let notified: { level: "warn" | "critical"; atMs: number } | null = null;

  async function resolveThresholds(): Promise<WsRootDiskSettings> {
    const botDisk = deps.getBotDiskSettings
      ? await deps.getBotDiskSettings()
      : ((await settingsService!.getGeneral()) as unknown as Record<string, unknown>).botDisk;
    return resolveWsRootDiskSettings({ stored: botDisk, env }).settings;
  }

  function isFreshPhysicalSample(usage: HostRootUsage, atMs: number): boolean {
    const age = atMs - Date.parse(usage.at);
    return Number.isFinite(age) && age >= 0 && age < HOST_ROOT_SAMPLE_MAX_AGE_MS
      && Number.isSafeInteger(usage.totalBytes) && usage.totalBytes > 0
      && Number.isSafeInteger(usage.usedBytes) && usage.usedBytes >= 0 && usage.usedBytes <= usage.totalBytes
      && Number.isSafeInteger(usage.freeBytes) && usage.freeBytes >= 0
      && usage.freeBytes <= usage.totalBytes - usage.usedBytes;
  }

  async function updateFromRoot(usage: HostRootUsage): Promise<HostRootThresholdState> {
    const settings = await resolveThresholds();
    if (!isFreshPhysicalSample(usage, now().getTime())) return markUnmeasured();
    // Derive the decision from bytes so an 84.999 % wire percent does not
    // alert (the same rule the bot partition runtime applies).
    usage = { ...usage, usedPercent: (usage.usedBytes / usage.totalBytes) * 100 };
    const alert = rootDiskAlertLevel(usage.usedPercent, settings);
    state = {
      root: usage,
      settings,
      alertLevel: alert,
      evaluatedAt: now().toISOString(),
    };
    if ((alert === "warn" || alert === "critical") && deps.notify) {
      const atMs = now().getTime();
      const last = notified;
      // The latch re-arms only below the warn threshold, and a level fires
      // at most once per repeat window (acceptance: no repeat within an hour).
      const reArmed = usage.usedPercent <= settings.rootThresholdPercent;
      const sameLevel = last?.level === alert;
      const due = !sameLevel
        || reArmed
        || last === null
        || atMs - last.atMs >= repeatIntervalMs;
      if (due) {
        try {
          await deps.notify({ usage, settings, level: alert });
          notified = { level: alert, atMs };
        } catch (err) {
          logger.error({ err }, "host root notification failed");
        }
      }
    }
    return state;
  }

  function markUnmeasured(): HostRootThresholdState {
    state = { ...EMPTY_STATE, evaluatedAt: now().toISOString() };
    return state;
  }

  return {
    updateFromRoot,
    markUnmeasured,
    current: () => state.root && !isFreshPhysicalSample(state.root, now().getTime())
      ? markUnmeasured()
      : state,
    resolveThresholds,
  };
}

const runtimes = new WeakMap<Db, HostRootThresholdRuntime>();

/** The process-wide runtime; the sweep, the attention feed and the routes share it. */
export function hostRootThresholdRuntime(
  db: Db,
  deps: HostRootThresholdDeps = {},
): HostRootThresholdRuntime {
  const existing = runtimes.get(db);
  if (existing) return existing;
  const runtime = createHostRootThresholdRuntime(db, deps);
  runtimes.set(db, runtime);
  return runtime;
}

/** Test hook: drop the cached runtime so each test gets a fresh latch. */
export function resetHostRootThresholdRuntime(db: Db): void {
  runtimes.delete(db);
}

/** Standalone runtime for tests (no WeakMap, no db). */
export function hostRootThresholdRuntimeForTest(
  deps: HostRootThresholdDeps = {},
): HostRootThresholdRuntime {
  return createHostRootThresholdRuntime(null, deps);
}
