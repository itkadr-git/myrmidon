// server/src/myrmidon/monitoring/board-load/index.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the wiring point of the board measurement.
//
// app.ts mounts `boardLoadApp(db)` inside `/api` with the other myrmidon
// routers and registers `boardLoadRequestMiddleware()` in front of them, so
// every request under `/api` is tagged with the `http_route` lane and
// journaled on finish.
//
// Unlike the metrics endpoint there is nothing to start: the lane counters
// count from the moment the module is imported, the request journal costs one
// object push per request, and the profiler is off until an operator asks for
// it. The one process-wide object is the runtime below — created lazily, so a
// test that imports this module creates nothing.

import type { RequestHandler } from "express";
import type { PgStatStatementsDbPort } from "./pg-stat-statements.js";
import { boardRequestLoadMiddleware, createRequestLog, type RequestLog } from "./request-load.js";
import { createCpuProfileRuntime, type CpuProfileRuntime } from "./cpu-profile.js";
import { boardLoadRoutes, type BoardLoadRoutesDeps } from "./routes.js";

export * from "./lanes.js";
export * from "./request-load.js";
export * from "./cpu-profile.js";
export * from "./pg-stat-statements.js";
export {
  API_LOAD_MAX_WINDOW_SEC,
  API_LOAD_MIN_WINDOW_SEC,
  CPU_PROFILE_ENABLED_ENV,
  boardLoadRoutes,
  cpuProfileEnabled,
  type BoardLoadRoutesDeps,
} from "./routes.js";

export interface BoardLoadRuntime {
  /** Journal of finished `/api` requests (design §1 П3). */
  requestLog: RequestLog;
  /** The process's one V8 profiler (design §1 П1). */
  cpuProfiles: CpuProfileRuntime;
}

/** A fresh runtime — one per process in production, one per test locally. */
export function createBoardLoadRuntime(): BoardLoadRuntime {
  return {
    requestLog: createRequestLog(),
    cpuProfiles: createCpuProfileRuntime(),
  };
}

let processRuntime: BoardLoadRuntime | null = null;

/** The runtime of this process, created on first use. */
export function boardLoadRuntime(): BoardLoadRuntime {
  if (!processRuntime) processRuntime = createBoardLoadRuntime();
  return processRuntime;
}

/**
 * The request-load middleware app.ts registers on the api router.
 *
 * It only observes: the lane tag, the journal entry on `finish`. It is
 * deliberately not a guard — an unauthenticated request is tagged and
 * journaled exactly like any other, so the summary shows the load the board
 * really served.
 */
export function boardLoadRequestMiddleware(): RequestHandler {
  return boardRequestLoadMiddleware(boardLoadRuntime().requestLog);
}

/** The router app.ts mounts under `/api`. */
export function boardLoadApp(db: PgStatStatementsDbPort): ReturnType<typeof boardLoadRoutes> {
  const runtime = boardLoadRuntime();
  const deps: BoardLoadRoutesDeps = {
    db,
    env: process.env,
    now: () => new Date(),
    requestLog: runtime.requestLog,
    cpuProfiles: runtime.cpuProfiles,
  };
  return boardLoadRoutes(deps);
}