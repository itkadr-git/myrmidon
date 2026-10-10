// server/src/services/leader-lease.ts
//
// myrmidon(1.6.6 PROCS-1.7 part A, design OPE-5394 §5.3): the leader lease of
// the board. One row per named lease in `board_leases`; the holder runs the
// leader-only background work (the fleet-console subsystems, the heartbeat
// scheduler, the backup), everyone else waits in the contender loop.
//
// The protocol is the one of design §5.3:
//   acquire: INSERT … ON CONFLICT DO NOTHING, then
//            UPDATE board_leases
//               SET holder_boot_id=me, epoch=epoch+1,
//                   acquired_at=now(), expires_at=now()+ttl
//             WHERE name=? AND (expires_at < clock_timestamp() OR holder_boot_id=me)
//         RETURNING epoch
//   renew:   the same UPDATE with holder_boot_id=me every ttl/3 (10 s by default).
//            A renewal that returns no row means the lease is gone → onLost().
//   expire:  the UPDATE WHERE carries the expiry check on clock_timestamp().
//   release: DELETE WHERE name=? AND holder_boot_id=me → the next contender
//            takes over within its own renewal tick (§5.3: ≤ 1 s handover at
//            shutdown, the release runs right after the timers stop).
//
// The reference pattern is `legacy-controller-lease.ts` (claim/renew/expire on
// `clock_timestamp()`, drizzle); the difference is the epoch fence and the
// onAcquired/onLost/onLeaderChanged lifecycle hooks that drive the §5.4
// stop-semantics of the former leader.

import { randomUUID } from "node:crypto";
import { and, eq, or, lt, sql } from "drizzle-orm";
import { boardLeases } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";


/** The named leases of the board (design §5.1). */
export const BOARD_LEASE_NAMES = ["scheduler", "backup"] as const;
export type BoardLeaseName = (typeof BOARD_LEASE_NAMES)[number];

export const LEADER_LEASE_TTL_DEFAULT_MS = 30_000;
/** §5.2: renewal runs at TTL/3 (30 s TTL → every 10 s). */
export const LEADER_LEASE_RENEW_DIVISOR = 3;

export type LeaderLeaseHooks = {
  /**
   * Fired on every handover (acquire, renew with a new holder, expiry
   * observed by a renew). Payload: the current holder and epoch after the
   * pass. `holderBootId === svc.bootId` means this process became leader.
   */
  onLeaderChanged?: (holderBootId: string, epoch: number) => void;
  /**
   * This process just acquired the lease. The returned epoch fences the
   * background passes started under this leadership.
   */
  onAcquired?: (epoch: number) => void;
  /**
   * §5.4: this process lost the lease. The AbortSignal aborts once — the
   * in-flight background sweeps that take the signal must stop; the loop
   * returns to the contender state (the process keeps living).
   */
  onLost?: (signal: AbortSignal, reason: "renew-failed" | "stopped" | "released") => void;
  log?: (level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) => void;
};

export type LeaderLeaseServiceOptions = {
  /** Identity of this boot; a fresh UUID when absent. */
  bootId?: string;
  /** Lease TTL (design §5.2 default 30 s). */
  ttlMs?: number;
  /** Renewal cadence (default ttlMs/3 ≈ 10 s). */
  renewIntervalMs?: number;
};

export type LeaderLease = {
  readonly name: BoardLeaseName;
  /** True while this process holds the lease. */
  isLeader(): boolean;
  /** The epoch of the current leadership (0 when not leader). */
  currentEpoch(): number;
  /**
   * §5.4: the AbortSignal of the current leadership epoch — aborted by
   * `onLost`. Background sweeps pass it to their in-flight work so the pass
   * stops when the lease is lost. Null while not the leader.
   */
  leaderSignal(): AbortSignal | null;
  /** Starts the contender loop (immediate acquire pass + renew timer). */
  start(): void;
  /** Stops the renew timer; the row stays until release() or expiry. */
  stop(): void;
  /**
   * Live timing update (design §5.7 «читаются на лету»): the manager calls
   * this when the operator edits `general.processes.leaderLeaseTtlSec`. The
   * next renew pass writes the new TTL into `expires_at`; the renew timer is
   * rescheduled when the interval changed. A running leadership is kept —
   * only the deadlines move.
   */
  setTiming(ttlMs: number, renewIntervalMs: number): void;
  /** Current TTL in ms (test hook / observability). */
  currentTtlMs(): number;
  /**
   * §5.3 shutdown release: DELETE the row so a standby acquires on its next
   * tick (≤ 1 s with the 10 s cadence; ≤ TTL at kill -9).
   */
  release(): Promise<void>;
};

export function leaderLeaseService(db: Db, options: LeaderLeaseServiceOptions = {}) {
  const bootId = options.bootId ?? randomUUID();
  const defaultTtlMs = options.ttlMs ?? LEADER_LEASE_TTL_DEFAULT_MS;
  const defaultRenewIntervalMs =
    options.renewIntervalMs ?? Math.max(1_000, Math.floor(defaultTtlMs / LEADER_LEASE_RENEW_DIVISOR));

  const lease = (name: BoardLeaseName, hooks: LeaderLeaseHooks = {}): LeaderLease => {
    const log = hooks.log ?? (() => {});
    let timer: NodeJS.Timeout | null = null;
    let epoch = 0;
    let lostController: AbortController | null = null;
    let ttlMs = defaultTtlMs;
    let renewIntervalMs = defaultRenewIntervalMs;

    const isLeader = () => epoch > 0;

    const fireLost = (reason: "renew-failed" | "stopped" | "released") => {
      if (!lostController) return;
      const controller = lostController;
      lostController = null;
      epoch = 0;
      hooks.onLost?.(controller.signal, reason);
    };

    /** The §5.3 UPDATE; returns the new epoch when the pass won, else null. */
    const tryTake = async (): Promise<number | null> => {
      const rows = await db
        .update(boardLeases)
        .set({
          holderBootId: bootId,
          epoch: sql`${boardLeases.epoch} + 1`,
          acquiredAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + ${ttlMs} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(boardLeases.name, name),
            or(
              lt(boardLeases.expiresAt, sql`clock_timestamp()`),
              eq(boardLeases.holderBootId, bootId),
            ),
          ),
        )
        .returning({ epoch: boardLeases.epoch });
      const row = rows[0];
      return row ? Number(row.epoch) : null;
    };

    /** One acquire pass: seed the row, then try to take it. */
    const acquirePass = async (): Promise<boolean> => {
      await db
        .insert(boardLeases)
        .values({
          name,
          holderBootId: bootId,
          epoch: 0,
          acquiredAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing();
      const won = await tryTake();
      if (won === null) return false;
      const prevEpoch = epoch;
      epoch = won;
      lostController = new AbortController();
      if (prevEpoch === 0) {
        hooks.onAcquired?.(won);
      }
      hooks.onLeaderChanged?.(bootId, won);
      return true;
    };

    /** One renew pass; failure (no row) means the lease is gone → onLost(). */
    const renewPass = async (): Promise<void> => {
      const won = await tryTake();
      if (won === null) {
        log("warn", "leader lease renew returned no row — lease lost", { name, bootId });
        fireLost("renew-failed");
        return;
      }
      epoch = won;
      hooks.onLeaderChanged?.(bootId, won);
    };

    const pass = async () => {
      try {
        if (epoch === 0) {
          const acquired = await acquirePass();
          if (!acquired) {
            const holder = await currentHolder();
            // holderBootId is nullable at the schema level (a row whose holder
            // vanished mid-write); the hook needs a concrete boot id.
            if (holder?.holderBootId) hooks.onLeaderChanged?.(holder.holderBootId, Number(holder.epoch));
          }
        } else {
          await renewPass();
        }
      } catch (err) {
        // A database error is not a lease loss: the row still names us and the
        // TTL keeps the worst case bounded. Retry on the next tick.
        log("error", "leader lease pass failed", {
          name,
          bootId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const currentHolder = async () => {
      const rows = await db
        .select({ holderBootId: boardLeases.holderBootId, epoch: boardLeases.epoch })
        .from(boardLeases)
        .where(eq(boardLeases.name, name));
      return rows[0] ?? null;
    };

    return {
      name,
      isLeader,
      currentEpoch: () => epoch,
      leaderSignal: () => (epoch > 0 ? lostController?.signal ?? null : null),
      start() {
        if (timer) return;
        void pass();
        timer = setInterval(() => void pass(), renewIntervalMs);
        if (typeof timer.unref === "function") timer.unref();
      },
      stop() {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
      setTiming(nextTtlMs: number, nextRenewIntervalMs: number) {
        ttlMs = nextTtlMs;
        if (nextRenewIntervalMs !== renewIntervalMs) {
          renewIntervalMs = nextRenewIntervalMs;
          if (timer) {
            clearInterval(timer);
            timer = setInterval(() => void pass(), renewIntervalMs);
            if (typeof timer.unref === "function") timer.unref();
          }
        }
      },
      currentTtlMs: () => ttlMs,
      async release() {
        this.stop();
        try {
          await db
            .delete(boardLeases)
            .where(and(eq(boardLeases.name, name), eq(boardLeases.holderBootId, bootId)));
          log("info", "leader lease released", { name, bootId });
        } catch (err) {
          log("error", "leader lease release failed", {
            name,
            bootId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        fireLost("released");
      },
    };
  };

  return { bootId, ttlMs: defaultTtlMs, renewIntervalMs: defaultRenewIntervalMs, lease };
}
