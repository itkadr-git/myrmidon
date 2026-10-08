// server/src/myrmidon/monitoring/board-load/lanes.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the load lanes of one board process.
//
// Design OPE-5394 §1 П2: the board's own CPU is spent by a handful of
// shapes of work — an inbound HTTP request, one pass of the heartbeat
// scheduler tick, the 1 s chat reconcile, the 15 s execution control, the
// 60 s bot-container reconcile and the run follow-up (event record). A
// measurement taken without knowing which of them was running cannot be
// acted on, so every one of them is a *lane*: a name attached to the async
// context of the work (AsyncLocalStorage) — so a DB statement issued
// anywhere below the lane boundary is attributed to it without threading a
// parameter through application code.
//
// The lane is an observation, not a scheduler: `runInLane` does not queue,
// order, delay or parallelize anything. Work that runs outside every lane
// (process startup, a one-off operator call, a detached promise that outlived
// its lane) is counted as `untagged` rather than dropped, so the lane totals
// always add up to the process total.
//
// Counters are plain in-process numbers with no store, no timer and no
// migration behind them — the same shape the process metrics of
// OPE-5402/PROCS-Q3 use, and the same reason: a scraper must be able to read
// them from a process that is already misbehaving.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The lanes of design OPE-5394 §1 П2, in exposition order.
 *
 * `untagged` is the last entry on purpose: it is the residue, not a lane the
 * board schedules.
 */
export const BOARD_LANES = [
  "http_route",
  "heartbeat_tick",
  "execution_control",
  "chat_reconcile",
  "bot_reconcile",
  "run_supervision",
  "untagged",
] as const;

export type BoardLane = (typeof BOARD_LANES)[number];

/** One lane's totals since process start. */
export interface BoardLaneSample {
  lane: BoardLane;
  /** DB statements issued below the lane boundary since start. */
  dbQueries: number;
  /** Wall milliseconds the lane spent inside its own scopes since start. */
  busyMs: number;
  /** Completed lane scopes since start. */
  executions: number;
}

interface LaneCounter {
  dbQueries: number;
  busyMs: number;
  executions: number;
}

const counters = new Map<BoardLane, LaneCounter>();
const laneStorage = new AsyncLocalStorage<BoardLane>();

function counterOf(lane: BoardLane): LaneCounter {
  let found = counters.get(lane);
  if (!found) {
    found = { dbQueries: 0, busyMs: 0, executions: 0 };
    counters.set(lane, found);
  }
  return found;
}

/** The lane in force for the caller, or `null` outside every lane. */
export function currentLane(): BoardLane | null {
  return laneStorage.getStore() ?? null;
}

/**
 * Counts one DB statement against the lane in force.
 *
 * Called by the DB client observer (`packages/db` `onQuery`) from wherever
 * the statement is issued; the lane is read from the async context, never
 * passed in by the caller, so a statement issued deep inside a service is
 * still attributed to the lane that started the work.
 */
export function recordLaneDbQuery(lane: BoardLane | null = currentLane()): void {
  counterOf(lane ?? "untagged").dbQueries += 1;
}

/**
 * Adds one finished scope's wall time to a lane.
 *
 * Split out of {@link runInLane} for the one scope that cannot be measured
 * from the inside: an HTTP request finishes long after the middleware that
 * tagged it returned, so the request load middleware pairs
 * {@link enterLane} with this call from its `finish` listener.
 */
export function recordLaneExecution(lane: BoardLane, busyMs: number): void {
  const counter = counterOf(lane);
  counter.executions += 1;
  if (Number.isFinite(busyMs) && busyMs > 0) counter.busyMs += busyMs;
}

/**
 * Runs `work` with `lane` attached to the async context — and nothing else.
 *
 * No measurement, no error handling: the caller owns both. Used where the
 * scope's duration is known by someone other than the code that starts it.
 */
export function enterLane<T>(lane: BoardLane, work: () => T): T {
  return laneStorage.run(lane, work);
}

/**
 * Runs `work` in `lane` unless it already runs in one, and returns it.
 *
 * For work that can be reached from two directions — a run event appended by
 * an operator's HTTP request is `http_route` load, the same append driven by
 * the supervision loops is `run_supervision`. Whoever owns the context first
 * wins, so no inner call can steal a request's attribution, and a background
 * caller that never entered a lane still gets one.
 */
export function enterLaneIfUntagged<T>(lane: BoardLane, work: () => T): T {
  if (currentLane() !== null) return work();
  return enterLane(lane, work);
}

/**
 * Runs `work` inside `lane`, adding its wall time and one execution to the
 * lane when it settles. Accepts a sync or an async worker and keeps the
 * caller's value and error exactly as they were.
 */
export function runInLane<T>(lane: BoardLane, work: () => T): T {
  const started = performance.now();
  const finish = () => recordLaneExecution(lane, performance.now() - started);
  try {
    const result = laneStorage.run(lane, work);
    if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
      return (result as Promise<unknown>).then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish();
          throw error;
        },
      ) as unknown as T;
    }
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

/**
 * `setInterval` whose every pass runs inside `lane`.
 *
 * The timer itself is untouched: same period, same drift, same
 * `unref`-ability as the call site had. A rejected pass is reported to
 * `onError` (or swallowed when no reporter is given) so a lane can never be
 * the reason an unrelated unhandled rejection appears in the process; a
 * synchronous throw propagates exactly as it did from the raw callback, which
 * is why the wrap keeps the call site's own error handling meaningful.
 */
export function laneInterval(
  lane: BoardLane,
  intervalMs: number,
  work: () => unknown,
  onError?: (error: unknown) => void,
): NodeJS.Timeout {
  return setInterval(() => {
    const result = runInLane(lane, work);
    if (result !== null && typeof result === "object" && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as Promise<unknown>).catch((error: unknown) => {
        if (onError) onError(error);
      });
    }
  }, intervalMs);
}

/**
 * Every lane's totals, always all of {@link BOARD_LANES} and always in that
 * order — a scraper must see a lane that never ran (as zeros) rather than
 * have to guess whether a missing series means "idle" or "not instrumented".
 */
export function readLaneSample(): BoardLaneSample[] {
  return BOARD_LANES.map((lane) => {
    const counter = counters.get(lane) ?? { dbQueries: 0, busyMs: 0, executions: 0 };
    return {
      lane,
      dbQueries: counter.dbQueries,
      busyMs: counter.busyMs,
      executions: counter.executions,
    };
  });
}

/**
 * Source seam of the metrics collector, mirroring `resolveProcessMetricsSource`:
 * a test (or a future out-of-process reader) can substitute the lane totals
 * without touching the registry.
 */
export type BoardLaneMetricsSource = (() => BoardLaneSample[]) | { read(): BoardLaneSample[] };

/** Resolves the lane source of a scrape, defaulting to the process registry. */
export function resolveLaneMetricsSource(
  source?: BoardLaneMetricsSource | null,
): () => BoardLaneSample[] {
  if (!source) return readLaneSample;
  return typeof source === "function" ? source : () => source.read();
}

/** Drops every lane counter. Test-only: the process never resets its lanes. */
export function resetLaneCounters(): void {
  counters.clear();
}