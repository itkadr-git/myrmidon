// server/src/myrmidon/process-registry/routes.ts
//
// myrmidon(1.6.5 PROCS-0.1): the read side of the registry — what the
// «Процессы» panel in Instance settings shows. Read-only by design: the rows
// are written by the processes themselves, never by an operator.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import {
  BOARD_PROCESS_PULSE_MS,
  BOARD_PROCESS_STALE_MS,
  boardProcessAgeSeconds,
  boardProcessBootId,
  boardProcessStatus,
} from "./domain.js";
import {
  createBoardLeaseStore,
  serializeBoardLeases,
  type BoardLeaseStore,
} from "./leases.js";
import { createBoardProcessStore, type BoardProcessRow, type BoardProcessStore } from "./store.js";

export type BoardProcessRegistryRoutesDeps = {
  store?: BoardProcessStore;
  leaseStore?: BoardLeaseStore;
  /** Identity of the process serving this request; defaults to this process. */
  bootId?: string;
  staleMs?: number;
  now?: () => Date;
};

export type BoardProcessView = {
  bootId: string;
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  /** Seconds since `startedAt` (uptime) at read time. */
  uptimeSeconds: number;
  ageSeconds: number;
  apiPort: number | null;
  eventLoopLagMs: number | null;
  rssBytes: number | null;
  status: "live" | "stale";
  /** True for the process that answers this request. */
  self: boolean;
};

function serializeBoardProcess(
  row: BoardProcessRow,
  context: { at: Date; bootId: string; staleMs: number },
): BoardProcessView {
  return {
    bootId: row.bootId,
    role: row.role,
    pid: row.pid,
    hostname: row.hostname,
    container: row.container,
    version: row.version,
    startedAt: row.startedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    uptimeSeconds: boardProcessAgeSeconds(row.startedAt, context.at),
    ageSeconds: boardProcessAgeSeconds(row.lastSeenAt, context.at),
    apiPort: row.apiPort,
    eventLoopLagMs: row.eventLoopLagMs,
    rssBytes: row.rssBytes,
    status: boardProcessStatus(row.lastSeenAt, context.at, context.staleMs),
    self: row.bootId === context.bootId,
  };
}

export function myrmidonBoardProcessRegistryRoutes(
  db: Db,
  deps: BoardProcessRegistryRoutesDeps = {},
) {
  const router = Router();
  const store = deps.store ?? createBoardProcessStore(db);
  const leaseStore = deps.leaseStore ?? createBoardLeaseStore(db);
  const bootId = deps.bootId ?? boardProcessBootId;
  const staleMs = deps.staleMs ?? BOARD_PROCESS_STALE_MS;
  const now = deps.now ?? (() => new Date());

  router.get("/myrmidon/board-processes", async (req, res, next) => {
    try {
      assertBoardOrgAccess(req);
      const at = now();
      const rows = await store.listProcesses();
      res.json({
        selfBootId: bootId,
        staleAfterSeconds: Math.round(staleMs / 1000),
        pulseSeconds: Math.round(BOARD_PROCESS_PULSE_MS / 1000),
        processes: rows.map((row) => serializeBoardProcess(row, { at, bootId, staleMs })),
      });
    } catch (error) {
      next(error);
    }
  });

  // The lease block of the panel: which process holds which named lease right
  // now. A single-process board holds none, so the list is empty.
  router.get("/myrmidon/processes/leases", async (req, res, next) => {
    try {
      assertBoardOrgAccess(req);
      const at = now();
      const [leases, processes] = await Promise.all([
        leaseStore.listLeases(),
        store.listProcesses(),
      ]);
      res.json(serializeBoardLeases({ leases, processes, bootId, at }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
