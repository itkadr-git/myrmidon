// server/src/myrmidon/process-readiness/routes.ts
//
// myrmidon(1.6.6 PROCS-1.5, design BOARD-PROCESSES §4.4): the two endpoints of
// the readiness contract.
//
//   GET /internal/ready — this process answers about itself. 200 means «готов
//     принимать»; 503 means the balancer must not send work here yet.
//   GET /healthz        — the aggregate the balancer polls. 200 only when the
//     answer is «the board can take traffic»; with a supervisor that means
//     every one of the N api processes is ready, and the supervisor's own
//     checks pass too (it is the process that applies migrations).
//
// Both are mounted at the app root, next to /api/health, because a load
// balancer and the container runtime probe them by path, not under /api. They
// read no credentials and expose no company data — a role name, a boot id, a
// count and three statuses — so they are safe to answer without an actor.

import type { Db } from "@paperclipai/db";
import express, { type Router } from "express";
import {
  healthzVerdict,
  readinessBody,
  READY_STATUS,
  NOT_READY_STATUS,
  type ProcessSupervisorReadinessSource,
} from "./domain.js";
import { createProcessReadiness, processSupervisorForHealthz, type ProcessReadiness } from "./service.js";

export type ProcessReadinessRouteDeps = {
  /** Test seam: a prepared readiness service instead of a real one. */
  readiness?: ProcessReadiness;
  /** The supervisor the aggregate covers. Absent on an api child and on a
   * process that never enters a split; the process-local registry (see
   * `registerProcessSupervisor`) is then consulted per request — the split
   * wiring registers its supervisor while booting, after the app is built, so
   * a value read once at construction would still be the pre-split `null`. */
  processSupervisor?: ProcessSupervisorReadinessSource | null;
  /** Test seam: the clock of the `at` field. */
  now?: () => Date;
};

export function myrmidonProcessReadinessRoutes(
  db: Db | null | undefined,
  deps: ProcessReadinessRouteDeps = {},
): Router {
  const readiness = deps.readiness ?? createProcessReadiness({ db: db ?? null });
  const supervisorOf = (): ProcessSupervisorReadinessSource | null =>
    deps.processSupervisor ?? processSupervisorForHealthz();
  const now = deps.now ?? (() => new Date());

  const router = express.Router();
  // A readiness answer is never cacheable: the next poll decides the deploy.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/internal/ready", async (_req, res) => {
    try {
      const snapshot = await readiness.snapshot();
      res.status(snapshot.ready ? READY_STATUS : NOT_READY_STATUS).json(readinessBody(snapshot));
    } catch (error) {
      // The endpoint itself must always answer: a throw here would look like a
      // dead process to the balancer, which is a stronger claim than «not
      // ready». The cause travels as a detail, never as a stack trace.
      res.status(NOT_READY_STATUS).json({
        status: "not_ready",
        ready: false,
        role: readiness.role(),
        bootId: readiness.bootId(),
        checks: [],
        error: error instanceof Error ? error.message : "readiness check failed",
        at: now().toISOString(),
      });
    }
  });

  router.get("/healthz", async (_req, res) => {
    const checks = await readiness.checks().catch(() => []);
    const verdict = healthzVerdict({
      role: readiness.role(),
      bootId: readiness.bootId(),
      selfReady: checks.every((check) => check.status !== "not_ready"),
      selfChecks: checks,
      supervisor: supervisorOf(),
      now: now(),
    });
    res.status(verdict.status).json(verdict.body);
  });

  return router;
}