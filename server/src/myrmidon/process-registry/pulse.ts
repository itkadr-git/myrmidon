// server/src/myrmidon/process-registry/pulse.ts
//
// myrmidon(1.6.6 PROCS-0.1, design BOARD-PROCESSES §5.1): the pulse — every
// process refreshes its own row every 10 s with its measurements, and the
// leader deletes rows whose last pulse is older than 2 min.
//
// The tick never throws: a registry that dies with a transient DB error would
// take the board's own liveness signal down exactly when it matters, so
// failures are reported through `onError` and the next tick retries.

import {
  enablePulseEventLoopMonitor,
  readMemorySample,
  readPulseEventLoopLagMs,
} from "../monitoring/metrics/process-metrics.js";
import {
  BOARD_PROCESS_PULSE_MS,
  BOARD_PROCESS_STALE_MS,
  roleOwnsBackgroundWork,
  type BoardProcessIdentity,
} from "./domain.js";
import type { BoardProcessPulseUpdate, BoardProcessStore } from "./store.js";

export type BoardProcessPulseFailurePhase = "pulse" | "reap";

export type BoardProcessPulseOptions = {
  store: BoardProcessStore;
  identity: BoardProcessIdentity;
  /** Pulse cadence; 10 s in production, shorter in tests. */
  pulseMs?: number;
  /** Staleness window used by the reaper; 2 min in production. */
  staleMs?: number;
  /** Per-tick measurements; defaults to this process's own observers. */
  readMetrics?: () => BoardProcessPulseUpdate;
  /** The leader reaps stale rows; by default every role that owns timers. */
  reap?: boolean;
  now?: () => Date;
  onError?: (error: unknown, phase: BoardProcessPulseFailurePhase) => void;
};

export type BoardProcessPulse = {
  /** Writes the first row immediately, then starts the timer (idempotent). */
  start(): void;
  stop(): void;
  /** One full tick: refresh the row, then reap when this process reaps. */
  tick(): Promise<void>;
  /** Deletes rows older than the window; returns how many were removed. */
  reapStale(at?: Date): Promise<number>;
  readonly running: boolean;
};

/** Default measurements of a tick: event-loop lag of the pulse window plus the
 * process RSS — the same observers the metrics exposition uses, so the panel
 * and the scrape cannot disagree about what "this process" measures. */
export function defaultBoardProcessPulseMetrics(): BoardProcessPulseUpdate {
  const memory = readMemorySample();
  return { eventLoopLagMs: readPulseEventLoopLagMs(), rssBytes: memory.rssBytes };
}

export function createBoardProcessPulse(options: BoardProcessPulseOptions): BoardProcessPulse {
  const pulseMs = options.pulseMs ?? BOARD_PROCESS_PULSE_MS;
  const staleMs = options.staleMs ?? BOARD_PROCESS_STALE_MS;
  const now = options.now ?? (() => new Date());
  const readMetrics = options.readMetrics ?? defaultBoardProcessPulseMetrics;
  const reap = options.reap ?? roleOwnsBackgroundWork(options.identity.role);
  const onError = options.onError ?? (() => {});
  let timer: ReturnType<typeof setInterval> | null = null;

  async function reapStale(at: Date = now()): Promise<number> {
    const cutoff = new Date(at.getTime() - staleMs);
    return options.store.deleteStale(cutoff);
  }

  async function tick(): Promise<void> {
    const at = now();
    try {
      await options.store.heartbeat(options.identity, readMetrics(), at);
    } catch (error) {
      onError(error, "pulse");
      return;
    }
    if (!reap) return;
    try {
      await reapStale(at);
    } catch (error) {
      onError(error, "reap");
    }
  }

  return {
    start() {
      if (timer) return;
      // The pulse owns its own delay histogram: reusing the scrape histogram
      // would shrink the exposition window to the 10 s cadence and quietly
      // change what myrmidon_board_event_loop_lag_seconds describes.
      enablePulseEventLoopMonitor();
      void tick();
      timer = setInterval(() => {
        void tick();
      }, pulseMs);
      // A registry timer must never hold the process open on shutdown.
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
    reapStale,
    get running() {
      return timer !== null;
    },
  };
}