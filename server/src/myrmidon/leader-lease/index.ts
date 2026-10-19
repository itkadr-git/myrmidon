// server/src/myrmidon/leader-lease/index.ts
//
// myrmidon(1.6.6 PROCS-1.7 part A, design OPE-5394 §5): the leader lease
// wiring of the board.
//
// The fleet-console subsystems (W2a bot containers, M2-A litellm costs, …)
// and the heartbeat scheduler are leader-only work: when several board
// processes share one database, exactly one of them may run these passes.
// This module owns the `board_leases` rows and the gating:
//
// - `createLeaderLeaseManager(db, opts)` builds one lease handle per named
//   lease (design §5.1). `start()` enters the contender loop, `releaseAll()`
//   is the §5.3 shutdown path (delete the row so a standby takes over ≤ 1 s).
// - The processes setting (`general.processes`, design §5.7, re-read on every
//   renewal pass) decides whether the lease protocol runs at all: with no
//   `processes` block (or `mode` not `"split"`) the board behaves exactly as
//   before — the single running process is the leader of everything, no rows
//   are written, no timers run. TTL comes from
//   `processes.leaderLeaseTtlSec` (default 30, clamped 5..300), renewal runs
//   at TTL/3 (default 10 s) per §5.2.
// - The leader pulses its `board_processes` row on every pass (§5.1);
//   `cleanupStaleProcesses` runs on the leader pass and removes rows older
//   than 2 min (§5.1 «строки старше 2 мин чистит лидер»).
//
// Attention + live events: every handover raises the «лидер сменился» signal
// (an activity-log entry the attention feed surfaces) and publishes
// `leader_changed` (§5.4.4).

import { activityLog, boardProcesses, type Db } from "@paperclipai/db";
import { lt } from "drizzle-orm";
import {
  leaderLeaseService,
  BOARD_LEASE_NAMES,
  type BoardLeaseName,
  type LeaderLease,
} from "../../services/leader-lease.js";
import { publishGlobalLiveEvent } from "../../services/live-events.js";
import { resolveBoardProcessIdentity } from "../process-registry/domain.js";


const STALE_PROCESS_AGE_MS = 120_000;

/**
 * The shape of the processes setting (`general.processes`, design §5.7). The
 * stored row is shared with PROCS-J's counts (api/worker), which own the key
 * in `packages/shared/src/myrmidon-board-processes.ts` (passthrough zod — the
 * lease fields ride along unvalidated). The lease protocol needs only the
 * mode switch and the TTL, read here as loose unknowns; `boardProcessesSettingsSchema`
 * in packages/shared/validators/instance.ts documents the full lease-side
 * shape for part B / UI validation. Absent or malformed values mean
 * «multi-process mode off» — the default behaviour of one process.
 */
export interface ProcessesSetting {
  mode?: string;
  leaderLeaseTtlSec?: number;
}

export const LEADER_LEASE_TTL_DEFAULT_SEC = 30;
export const LEADER_LEASE_TTL_MIN_SEC = 5;
export const LEADER_LEASE_TTL_MAX_SEC = 300;

function isMultiProcessEnabled(setting: ProcessesSetting | null | undefined): boolean {
  return setting?.mode === "split";
}

export function leaseTtlSec(setting: ProcessesSetting | null | undefined): number {
  const ttl = setting?.leaderLeaseTtlSec;
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) return LEADER_LEASE_TTL_DEFAULT_SEC;
  return Math.min(LEADER_LEASE_TTL_MAX_SEC, Math.max(LEADER_LEASE_TTL_MIN_SEC, Math.floor(ttl)));
}

export type LeaderLeaseManagerOptions = {
  /** Identity of this boot (design §5.1); a fresh UUID when absent. */
  bootId?: string;
  /** Board version string for the board_processes row. */
  version?: string;
  /** Fixed TTL override (tests). The settings value wins when present. */
  ttlMs?: number;
  /** Fixed renewal interval override (tests). Defaults to TTL/3. */
  renewIntervalMs?: number;
  /**
   * Reads the live processes setting (`general.processes`; the brief: «вся
   * новая настройка — через интерфейс доски без перезапуска», design §5.7
   * «читаются на лету»). Returning null means the block is absent. When the
   * reader itself is absent the manager stays in single-process mode.
   */
  readProcessesSetting?: () => Promise<ProcessesSetting | null>;
  /** Company the attention signals are scoped to; null skips the signal. */
  resolveSystemCompanyId?: () => Promise<string | null>;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
};

export type LeaderLeaseManager = {
  readonly bootId: string;
  start(): void;
  /** True while this process holds the named lease (or leases are disabled). */
  isLeader(name: BoardLeaseName): boolean;
  /** True while this process holds every leader lease it manages. */
  isLeaderOfAll(): boolean;
  /**
   * §5.4 stop-semantics: the signal of the current leader epoch for the named
   * lease; aborts when the lease is lost so the in-flight background pass
   * stops. Null while this process is not the leader (multi-process mode).
   */
  leaderSignal(name: BoardLeaseName): AbortSignal | null;
  /** Release every held lease (design §5.3 shutdown path). */
  releaseAll(): Promise<void>;
  /** Stop every renewal loop without deleting rows (test hook). */
  stopAll(): void;
};

export function createLeaderLeaseManager(
  db: Db,
  options: LeaderLeaseManagerOptions = {},
): LeaderLeaseManager {
  const log = options.log ?? (() => {});
  const svc = leaderLeaseService(db, {
    bootId: options.bootId,
    ttlMs: options.ttlMs,
    renewIntervalMs: options.renewIntervalMs,
  });
  const bootId = svc.bootId;
  const identity = resolveBoardProcessIdentity({ version: options.version ?? "unknown" });
  const processStartedAt = new Date();

  type LeaseEntry = { handle: LeaderLease; controller: AbortController | null };
  const leases = new Map<BoardLeaseName, LeaseEntry>();

  /** §5.4.4 — the «лидер сменился» attention signal on every handover. */
  const raiseLeaderChangedSignal = async (
    name: string,
    holderBootId: string | null,
    epoch: number,
    direction: "acquired" | "lost" | "observed",
  ) => {
    try {
      const companyId = options.resolveSystemCompanyId ? await options.resolveSystemCompanyId() : null;
      if (!companyId) return;
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "leader-lease",
        action: "board.leader_changed",
        entityType: "board_lease",
        entityId: name,
        details: {
          lease: name,
          holderBootId,
          epoch,
          direction,
          thisBootId: bootId,
        },
      });
    } catch (err) {
      log("error", "leader_changed signal write failed", {
        lease: name,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** §5.1 — the leader pulses its board_processes row on every pass. */
  const pulseProcessRow = async () => {
    const now = new Date();
    await db
      .insert(boardProcesses)
      .values({
        bootId,
        role: identity.role,
        pid: identity.pid,
        hostname: identity.hostname,
        container: identity.container,
        version: identity.version,
        apiPort: null,
        eventLoopLagMs: null,
        rssBytes: process.memoryUsage().rss,
        startedAt: processStartedAt,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: boardProcesses.bootId,
        set: { lastSeenAt: now, rssBytes: process.memoryUsage().rss },
      });
  };

  /** §5.1 — «строки старше 2 мин чистит лидер». */
  const cleanupStaleProcesses = async () => {
    const cutoff = new Date(Date.now() - STALE_PROCESS_AGE_MS);
    await db.delete(boardProcesses).where(lt(boardProcesses.lastSeenAt, cutoff));
  };

  for (const name of BOARD_LEASE_NAMES) {
    const entry: LeaseEntry = { handle: null as unknown as LeaderLease, controller: null };
    entry.handle = svc.lease(name, {
      onAcquired: (epoch) => {
        entry.controller = new AbortController();
        log("info", "this board process is the leader", { lease: name, bootId, epoch });
        void pulseProcessRow().catch((err) =>
          log("error", "board_processes pulse failed", {
            lease: name,
            err: err instanceof Error ? err.message : String(err),
          }),
        );
        if (name === "scheduler") {
          void cleanupStaleProcesses().catch((err) =>
            log("error", "board_processes cleanup failed", {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        void raiseLeaderChangedSignal(name, bootId, epoch, "acquired");
      },
      onLost: (signal, reason) => {
        entry.controller?.abort();
        entry.controller = null;
        log("warn", "this board process lost the leadership", { lease: name, bootId, reason });
        void raiseLeaderChangedSignal(name, null, entry.handle.currentEpoch() ?? 0, "lost");
        void signal; // handed to callers via leaderSignal(); the abort above fires it
      },
      onLeaderChanged: (holder, epoch) => {
        if (holder !== bootId) entry.controller = null;
        publishGlobalLiveEvent({
          type: "board.leader_changed",
          payload: {
            lease: name,
            holderBootId: holder,
            epoch,
          },
        });
        if (holder !== bootId) {
          void raiseLeaderChangedSignal(name, holder, epoch, "observed");
        }
      },
      log,
    });
    leases.set(name, entry);
  }

  const readSetting = async (): Promise<ProcessesSetting | null> => {
    if (!options.readProcessesSetting) return null;
    try {
      return await options.readProcessesSetting();
    } catch (err) {
      log("error", "processes settings read failed; keeping the current state", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  let enabled = false;
  let started = false;
  let settingsTimer: NodeJS.Timeout | null = null;
  /** Settings poll cadence — same order as the renewal tick (§5.7 live read). */
  const SETTINGS_POLL_MS = Math.max(1_000, options.renewIntervalMs ?? 10_000);
  let lastTtlSec: number | null = null;

  /** Apply the live setting: mode flips and TTL edits without a restart. */
  const applySetting = async (block: ProcessesSetting | null) => {
    const wantEnabled = isMultiProcessEnabled(block);
    const ttlSec = leaseTtlSec(block);
    const ttlChanged = lastTtlSec !== null && ttlSec !== lastTtlSec;
    lastTtlSec = ttlSec;
    const ttlMs = ttlSec * 1_000;
    const renewMs = Math.max(1_000, Math.floor(ttlMs / 3));

    if (wantEnabled && !enabled) {
      enabled = true;
      log("info", "processes mode is split — entering the leader lease contender loop", { ttlSec });
      for (const { handle } of leases.values()) {
        handle.setTiming(ttlMs, renewMs);
        handle.start();
      }
      return;
    }
    if (!wantEnabled && enabled) {
      enabled = false;
      log("info", "processes mode switched to single — releasing the leader leases");
      for (const { handle } of leases.values()) {
        await handle.release();
      }
      return;
    }
    if (wantEnabled && ttlChanged) {
      log("info", "leader lease TTL changed live", { ttlSec });
      for (const { handle } of leases.values()) handle.setTiming(ttlMs, renewMs);
    }
  };

  return {
    bootId,
    start() {
      if (started) return;
      started = true;
      const tick = () => void readSetting().then(applySetting);
      tick();
      settingsTimer = setInterval(tick, SETTINGS_POLL_MS);
      if (typeof settingsTimer.unref === "function") settingsTimer.unref();
    },
    isLeader(name) {
      // Single-process mode: the running process is the leader of everything
      // by definition (design §5.1 — поведение по умолчанию не меняется).
      if (!enabled) return true;
      return leases.get(name)?.handle.isLeader() ?? false;
    },
    isLeaderOfAll() {
      if (!enabled) return true;
      for (const { handle } of leases.values()) {
        if (!handle.isLeader()) return false;
      }
      return true;
    },
    leaderSignal(name) {
      if (!enabled) return null;
      const entry = leases.get(name);
      if (!entry || !entry.handle.isLeader()) return null;
      return entry.controller?.signal ?? null;
    },
    async releaseAll() {
      if (settingsTimer) {
        clearInterval(settingsTimer);
        settingsTimer = null;
      }
      for (const { handle } of leases.values()) {
        await handle.release();
      }
    },
    stopAll() {
      if (settingsTimer) {
        clearInterval(settingsTimer);
        settingsTimer = null;
      }
      for (const { handle } of leases.values()) handle.stop();
    },
  };
}
