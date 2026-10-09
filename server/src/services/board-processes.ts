// server/src/services/board-processes.ts
//
// myrmidon(PROCS-0.1): the process pulse behind the board_processes table
// (OPE-5394 §5.1, этап 0).
//
// Every board process owns exactly one row, keyed by its boot id: inserted
// once at start, then re-pulsed every PULSE_INTERVAL_MS with the moving
// parts (last_seen_at, event_loop_lag_ms, rss_bytes). The row is the source
// of Instance settings → Processes and of the multi-process work that
// follows PROCS-0.1.
//
// Stale rows (a process that died without shutdown) are deleted past
// STALE_AFTER_MS. Any process may run the sweep; an advisory try-lock makes
// exactly one process sweep per turn when several processes share the
// database — the "leader cleans up" of the design without a dedicated
// leader role existing yet (PROCS-1.1). The sweep is best-effort: a lost
// turn is retried on the next pulse.
//
// The service never throws out of its timer: a failed pulse is logged and
// retried on the next tick, so a transient DB error cannot crash the board.
// The timers are unref-ed and `stop()` clears them, so tests are not held
// open by the pulse.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { sql } from "drizzle-orm";
import { boardProcesses, type Db } from "@paperclipai/db";
import { readEventLoopSample, readMemorySample } from "../myrmidon/monitoring/metrics/process-metrics.js";
import { serverVersion } from "../version.js";
import { logger } from "../middleware/logger.js";

/** How often a process rewrites its own row. */
export const PULSE_INTERVAL_MS = 10_000;
/** A row whose pulse is older than this is a dead process; the sweep deletes it. */
export const STALE_AFTER_MS = 120_000;

/**
 * The try-lock key of the stale-row sweep. One fixed key for the whole
 * instance: board_processes is instance-scoped, so one sweeper at a time.
 */
const SWEEP_LOCK_KEY = "paperclip:board-processes:sweep";

export type BoardProcessIdentity = {
  bootId: string;
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  apiPort: number;
};

export type BoardProcessPulseOptions = {
  /** Boot id of this process; defaults to a fresh randomUUID(). */
  bootId?: string;
  /** Process role of the PROCS profile; "single" until PROCS-1.1 lands. */
  role?: string;
  /** API port this process listens on. */
  apiPort: number;
  /** Test hooks. */
  now?: () => Date;
  pid?: number;
  hostname?: string;
  container?: string | null;
  version?: string;
  pulseIntervalMs?: number;
  staleAfterMs?: number;
};

/** The Docker container id is the cgroup leaf on a containerized board. */
function detectContainer(): string | null {
  const fromEnv = process.env.PAPERCLIP_CONTAINER_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    // /proc/self/cgroup exists on Linux only; a non-Linux dev host reports null.
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const match = cgroup.match(/(?:docker|containerd|kubepods[^\n]*)\/([0-9a-f]{64})/);
    return match ? match[1]!.slice(0, 12) : null;
  } catch {
    return null;
  }
}

export function boardProcessPulseService(db: Db, options: BoardProcessPulseOptions) {
  const now = options.now ?? (() => new Date());
  const pulseIntervalMs = options.pulseIntervalMs ?? PULSE_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const identity: BoardProcessIdentity = {
    bootId: options.bootId ?? randomUUID(),
    role: options.role ?? "single",
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? osHostname(),
    container: options.container !== undefined ? options.container : detectContainer(),
    version: options.version ?? serverVersion,
    apiPort: options.apiPort,
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function pulseSample() {
    const loop = readEventLoopSample();
    const memory = readMemorySample();
    return {
      eventLoopLagMs: loop ? Math.round(loop.p99Seconds * 1000) : null,
      rssBytes: memory.rssBytes,
    };
  }

  /** Insert or refresh this process's row. */
  async function pulse(): Promise<void> {
    const sample = pulseSample();
    const at = now();
    await db
      .insert(boardProcesses)
      .values({
        bootId: identity.bootId,
        role: identity.role,
        pid: identity.pid,
        hostname: identity.hostname,
        container: identity.container,
        version: identity.version,
        apiPort: identity.apiPort,
        startedAt: at,
        lastSeenAt: at,
        eventLoopLagMs: sample.eventLoopLagMs,
        rssBytes: sample.rssBytes,
      })
      .onConflictDoUpdate({
        target: boardProcesses.bootId,
        set: {
          // started_at and the identity columns are immutable per boot: a
          // conflict means our own row, so only the moving parts change.
          lastSeenAt: at,
          eventLoopLagMs: sample.eventLoopLagMs,
          rssBytes: sample.rssBytes,
        },
      });
  }

  /**
   * Delete rows of dead processes. The advisory try-lock makes exactly one
   * process sweep per turn; a process that loses the lock simply skips —
   * the winner sweeps for everyone.
   */
  async function sweepStale(): Promise<number> {
    const cutoff = new Date(now().getTime() - staleAfterMs);
    return await db.transaction(async (tx) => {
      const locked = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${SWEEP_LOCK_KEY})) as acquired`,
      );
      const rows = locked as unknown as Array<{ acquired: boolean }>;
      if (!rows[0]?.acquired) return 0;
      const deleted = await tx.execute(
        sql`delete from board_processes where last_seen_at < ${cutoff}`,
      );
      // postgres.js returns { count } on a write; drizzle passes it through.
      const count = (deleted as unknown as { count?: number }).count;
      return typeof count === "number" ? count : 0;
    });
  }

  async function tick(): Promise<void> {
    try {
      await pulse();
    } catch (err) {
      logger.error({ err, bootId: identity.bootId }, "board process pulse failed");
    }
    try {
      await sweepStale();
    } catch (err) {
      logger.error({ err, bootId: identity.bootId }, "board process stale sweep failed");
    }
  }

  return {
    identity,

    /**
     * Insert the row now, then pulse on the interval. The initial pulse runs
     * before this resolves so a boot failure surfaces at startup instead of
     * silently deferring to the first tick.
     */
    async start(): Promise<void> {
      await pulse();
      if (stopped) return;
      timer = setInterval(() => {
        void tick();
      }, pulseIntervalMs);
      timer.unref?.();
    },

    /** Best-effort final cleanup: remove our row on a clean shutdown. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        await db
          .delete(boardProcesses)
          .where(sql`${boardProcesses.bootId} = ${identity.bootId}`);
      } catch (err) {
        logger.error({ err, bootId: identity.bootId }, "board process row cleanup failed");
      }
    },
  };
}

export type BoardProcessPulseService = ReturnType<typeof boardProcessPulseService>;
