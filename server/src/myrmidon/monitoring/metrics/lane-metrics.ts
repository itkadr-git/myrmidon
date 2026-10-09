// server/src/myrmidon/monitoring/metrics/lane-metrics.ts
//
// myrmidon(1.6.5-PROCS-T02): the call sites that label board work, and the
// accounting that hangs off the label — the lane of the work being run
// (lane-context.ts), the busy seconds the labelled section occupied, and the
// DB queries its reads issued. The query side is a seam in
// packages/db/src/myrmidon-query-accounting.ts: the driver reports every query,
// this module attributes it to `currentLane()`.
//
// The constants below are the Lane scale of the multi-process design (П2):
// one label per bounded unit of background work, plus one for the API request
// handlers. Renaming a constant renames a metric label — it is a wire name.

import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";
import { setDbQueryObserver } from "@paperclipai/db";
import { currentLane, withLane } from "./lane-context.js";
import { recordLaneBusySeconds, recordLaneQuery } from "./process-metrics.js";

export { currentLane, withLane };

/** One scheduler tick (both tick paths of the process). */
export const TICK_LANE = "tick";
/** The execution-control sweeps, one label for every queue. */
export const EXECUTION_CONTROL_LANE = "execution-control";
/** One chat reconciliation pass. */
export const CHAT_RECONCILE_LANE = "chat-reconcile";
/** One periodic bot reconciliation pass. */
export const BOT_RECONCILE_LANE = "bot-reconcile";
/** The API request handlers. */
export const API_LANE = "api";

/**
 * Express middleware that runs everything after it under the api lane, so the
 * reads a handler issues count into lane="api". Mounted once, ahead of the
 * board's API routes. No busy seconds are recorded for it: the wall time of a
 * request is not a bounded unit of work — an SSE response stays open for the
 * life of its stream.
 */
export function myrmidonApiLaneMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  withLane(API_LANE, next);
}

/**
 * Runs a bounded unit of board work under its lane and adds its wall time to
 * that lane's busy seconds. The label reaches every read the work starts —
 * including the ones resumed after an `await` — and a unit that throws still
 * spent its time, so the failure path is measured too. The return value (and
 * the rejection) of `fn` is passed through unchanged.
 */
export function runInLane<T>(lane: string, fn: () => T): T {
  return withLane(lane, () => {
    const startedAt = performance.now();
    const done = () => recordLaneBusySeconds(lane, (performance.now() - startedAt) / 1000);
    let result: T;
    try {
      result = fn();
    } catch (error) {
      done();
      throw error;
    }
    if (isThenable(result)) {
      return result.then(
        (value) => {
          done();
          return value;
        },
        (error) => {
          done();
          throw error;
        },
      ) as unknown as T;
    }
    done();
    return result;
  });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Attributes DB queries of this process to the lane that issued them
 * (idempotent). Production calls it once at boot: counters must count from
 * process start, not from the first scrape. A process that never labels
 * anything keeps counting into "unlabeled".
 */
export function startLaneQueryAccounting(): void {
  setDbQueryObserver(() => recordLaneQuery(currentLane()));
}