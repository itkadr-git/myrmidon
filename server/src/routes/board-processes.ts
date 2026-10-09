// server/src/routes/board-processes.ts
//
// myrmidon(PROCS-0.1): GET /api/instance/processes — the read behind the
// «Процессы» panel of Instance settings. Answers the board_processes table
// (one row per live board process, pulsed every 10 s), newest boot first.
//
// The route is instance-scoped, not per-company: the process registry
// describes the board itself, so the guard is the same board/org access the
// other instance-settings reads use. There is no write surface here — rows
// appear and disappear through the pulse and the stale sweep only.

import { Router } from "express";
import { desc } from "drizzle-orm";
import { boardProcesses, type Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "./authz.js";

export function boardProcessesRoutes(db: Db) {
  const router = Router();

  router.get("/instance/processes", async (req, res) => {
    assertBoardOrgAccess(req);
    const rows = await db
      .select()
      .from(boardProcesses)
      .orderBy(desc(boardProcesses.startedAt), desc(boardProcesses.bootId));
    res.json(
      rows.map((row) => ({
        bootId: row.bootId,
        role: row.role,
        pid: row.pid,
        hostname: row.hostname,
        container: row.container,
        version: row.version,
        startedAt: row.startedAt,
        lastSeenAt: row.lastSeenAt,
        apiPort: row.apiPort,
        eventLoopLagMs: row.eventLoopLagMs,
        rssBytes: row.rssBytes,
      })),
    );
  });

  return router;
}
