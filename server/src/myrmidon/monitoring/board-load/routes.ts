// server/src/myrmidon/monitoring/board-load/routes.ts
//
// myrmidon(1.6.6 PROCS-0.3A): the operator surface of the board measurement.
//
// Four questions, one route group, mounted under `/api` next to the other
// myrmidon routes:
//
//   GET  /api/myrmidon/board-load/lanes             which lane spends the CPU
//   GET  /api/myrmidon/board-load/api-load          p95 per route over a window
//   GET  /api/myrmidon/board-load/pg-stat-statements top-20 statements by total time
//   GET  /api/myrmidon/board-load/cpu-profile        status of the last capture
//   POST /api/myrmidon/board-load/cpu-profile        take a profile (60 s max)
//   GET  /api/myrmidon/board-load/cpu-profile/latest download the last capture
//
// Every read is an ordinary board read; the two endpoints that either read
// production SQL text or start a process-wide profiler are instance-admin only,
// the same rule the instance settings follow. Nothing here is stateful: the
// numbers live in the in-process registries (lanes.ts, request-load.ts) and a
// route only reports what they already hold.

import { Router } from "express";
import type { Request, Response } from "express";
import { assertBoardOrgAccess, assertInstanceAdmin } from "../../../routes/authz.js";
import { readLaneSample, type BoardLaneSample } from "./lanes.js";
import {
  DEFAULT_REQUEST_LOAD_ROUTES,
  DEFAULT_REQUEST_LOAD_WINDOW_SEC,
  type RequestLoadRouteSample,
  type RequestLog,
} from "./request-load.js";
import { CpuProfileBusyError, type CpuProfileRuntime } from "./cpu-profile.js";
import {
  clampPgStatStatementsLimit,
  readPgStatStatements,
  type PgStatStatementsDbPort,
  type PgStatStatementsRead,
} from "./pg-stat-statements.js";

/**
 * Hard switch of the profiler endpoint. Absent or anything but `false` leaves
 * the endpoint available (it is admin-gated and explicitly requested);
 * `false` answers 503 so an operator can take the capability off the board
 * without a deploy.
 */
export const CPU_PROFILE_ENABLED_ENV = "MYRMIDON_CPU_PROFILE_ENABLED";

/** Window bounds of the API load summary, in seconds. */
export const API_LOAD_MIN_WINDOW_SEC = 60;
export const API_LOAD_MAX_WINDOW_SEC = 86_400;

export interface BoardLoadRoutesDeps {
  db: PgStatStatementsDbPort;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Auth seams — the real guards unless a test injects permissive ones. */
  assertRead?: (req: Request) => void;
  assertAdmin?: (req: Request) => void;
  /** The journal the request middleware writes to. */
  requestLog?: RequestLog | null;
  /** The process's one profiler. */
  cpuProfiles?: CpuProfileRuntime;
  /** Lane source seam, defaulting to the process registry. */
  lanes?: () => BoardLaneSample[];
  /** Statement read seam, defaulting to the real `pg_stat_statements` read. */
  readStatements?: (db: PgStatStatementsDbPort, limit: number) => Promise<PgStatStatementsRead>;
}

/** `false` (any case, trimmed) disables the profiler endpoint. */
export function cpuProfileEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = env?.[CPU_PROFILE_ENABLED_ENV]?.trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

function clampWindowSec(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_LOAD_WINDOW_SEC;
  const whole = Math.floor(value);
  if (whole < API_LOAD_MIN_WINDOW_SEC) return API_LOAD_MIN_WINDOW_SEC;
  if (whole > API_LOAD_MAX_WINDOW_SEC) return API_LOAD_MAX_WINDOW_SEC;
  return whole;
}

function clampRouteLimit(raw: unknown): number {
  const value =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_REQUEST_LOAD_ROUTES;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  if (whole > DEFAULT_REQUEST_LOAD_ROUTES) return DEFAULT_REQUEST_LOAD_ROUTES;
  return whole;
}

/** `board-cpu-profile-20261008-123456.cpuprofile` — filename-safe by construction. */
function profileFileName(finishedAt: string): string {
  const digits = finishedAt.replace(/[^0-9]/g, "").slice(0, 14);
  return `board-cpu-profile-${digits.length > 0 ? digits : "capture"}.cpuprofile`;
}

function sendProfile(res: Response, json: string, finishedAt: string): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${profileFileName(finishedAt)}"`);
  res.send(json);
}

export function boardLoadRoutes(deps: BoardLoadRoutesDeps) {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const env = deps.env;
  const assertRead = deps.assertRead ?? assertBoardOrgAccess;
  const assertAdmin = deps.assertAdmin ?? assertInstanceAdmin;
  const readLanes = deps.lanes ?? readLaneSample;
  const readStatements = deps.readStatements ?? readPgStatStatements;
  const requestLog = deps.requestLog ?? null;
  const cpuProfiles = deps.cpuProfiles ?? null;

  router.get("/myrmidon/board-load/lanes", (req, res) => {
    assertRead(req);
    res.json({ collectedAt: now().toISOString(), lanes: readLanes() });
  });

  router.get("/myrmidon/board-load/api-load", (req, res) => {
    assertRead(req);
    const windowSec = clampWindowSec(req.query.window);
    const limit = clampRouteLimit(req.query.limit);
    const routes: RequestLoadRouteSample[] = requestLog
      ? requestLog.read({ windowMs: windowSec * 1000, now: now().getTime(), limit })
      : [];
    res.json({
      collectedAt: now().toISOString(),
      windowSec,
      journalSize: requestLog ? requestLog.size() : 0,
      routes,
    });
  });

  router.get("/myrmidon/board-load/pg-stat-statements", async (req, res) => {
    assertAdmin(req);
    const limit = clampPgStatStatementsLimit(req.query.limit);
    const report = await readStatements(deps.db, limit);
    res.json({ collectedAt: now().toISOString(), limit, ...report });
  });

  router.get("/myrmidon/board-load/cpu-profile", (req, res) => {
    assertRead(req);
    const enabled = cpuProfileEnabled(env);
    res.json({
      collectedAt: now().toISOString(),
      enabled,
      status: cpuProfiles ? cpuProfiles.status() : null,
    });
  });

  router.post("/myrmidon/board-load/cpu-profile", async (req, res) => {
    assertAdmin(req);
    if (!cpuProfileEnabled(env)) {
      res.status(503).json({
        error: "cpu_profile_disabled",
        detail: `${CPU_PROFILE_ENABLED_ENV} is set to false`,
      });
      return;
    }
    if (!cpuProfiles) {
      res.status(503).json({ error: "cpu_profile_unavailable", detail: "no profiler runtime is wired" });
      return;
    }
    const body = (req.body ?? {}) as { seconds?: unknown };
    try {
      const capture = await cpuProfiles.capture({ seconds: body.seconds });
      sendProfile(res, capture.json, capture.finishedAt);
    } catch (error) {
      if (error instanceof CpuProfileBusyError) {
        res.status(409).json({ error: "cpu_profile_busy", detail: error.message });
        return;
      }
      // A rejected async handler never reaches express's error middleware, so
      // the failure is answered here rather than thrown into the void.
      res.status(500).json({
        error: "cpu_profile_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.get("/myrmidon/board-load/cpu-profile/latest", (req, res) => {
    assertAdmin(req);
    const status = cpuProfiles ? cpuProfiles.status() : null;
    const json = cpuProfiles ? cpuProfiles.latestJson() : null;
    if (!json || !status?.latest) {
      res.status(404).json({ error: "cpu_profile_not_captured", detail: "no retained capture" });
      return;
    }
    sendProfile(res, json, status.latest.finishedAt);
  });

  return router;
}