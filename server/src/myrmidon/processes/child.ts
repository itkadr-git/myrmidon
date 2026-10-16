// server/src/myrmidon/processes/child.ts
//
// myrmidon(PROCS-1.2, design OPE-5394 §7.1): the api-child side of the
// supervisor contract. Two behaviours, both no-ops outside a forked child
// (`process.send` absent):
//
//  - `reportReady` — after the public listener is bound and a `SELECT 1`
//    against the database succeeded, the child tells the worker it may count
//    it toward the split's readiness quorum.
//  - `wireDrainHandler` — when the worker sends `drain` (apiCount down,
//    split→single rollback), the child closes its HTTP server, nudges idle
//    connections, closes websocket clients with 1012, waits out the grace,
//    forces remaining connections closed, and exits 0 (design §7.2).

import type { Server as HttpServer } from "node:http";
import { logger } from "../../middleware/logger.js";
import { SUPERVISOR_IPC_DRAIN, SUPERVISOR_IPC_READY } from "./supervisor.js";

interface DrainableWebSocket {
  close(code?: number, reason?: string): void;
}

/** What the drain handler needs from the process it lives in. */
export interface ChildDrainDeps {
  server: HttpServer;
  /** Live websocket clients, closed with 1012 so the UI reconnects. */
  wsClients(): Iterable<DrainableWebSocket>;
  /** App services teardown (`app.locals.paperclipShutdown`), best-effort. */
  shutdownAppServices?: () => Promise<void>;
  exit(code: number): void;
  setTimeout: (fn: () => void, ms: number) => { unref?: () => void };
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
}

function ipcSend(message: Record<string, unknown>): boolean {
  const send = (process as NodeJS.Process & { send?: (m: unknown) => boolean }).send;
  if (typeof send !== "function") return false;
  try {
    return send(message);
  } catch {
    return false;
  }
}

/** Whether this process is a supervised fork (has the IPC channel). */
export function isSupervisedChild(): boolean {
  return typeof (process as NodeJS.Process & { send?: unknown }).send === "function";
}

/**
 * Tell the worker this child is serving and its database answered `SELECT 1`.
 * Returns whether the message went out — false in a non-forked process, where
 * the call is a deliberate no-op.
 */
export function reportReadyToSupervisor(): boolean {
  const sent = ipcSend({ type: SUPERVISOR_IPC_READY, pid: process.pid });
  if (sent) {
    logger.info({ pid: process.pid }, "myrmidon(PROCS-1.2): api child reported ready to the worker");
  }
  return sent;
}

/**
 * Arm the drain handler. The worker's `drain` message starts a graceful exit:
 * the listener stops accepting, idle sockets close, websocket clients get
 * 1012, and after the grace window the remaining sockets are destroyed and
 * the process exits 0 so the worker does not count it as a crash.
 */
export function wireSupervisorDrainHandler(deps: ChildDrainDeps): void {
  if (!isSupervisedChild()) return;
  let draining = false;

  process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const typed = message as { type?: unknown; graceMs?: unknown };
    if (typed.type !== SUPERVISOR_IPC_DRAIN || draining) return;
    draining = true;
    const graceMs = typeof typed.graceMs === "number" && typed.graceMs > 0 ? typed.graceMs : 30_000;
    deps.log.info({ pid: process.pid, graceMs }, "myrmidon(PROCS-1.2): api child draining on supervisor request");

    let finalized = false;
    async function finalize(): Promise<void> {
      if (finalized) return;
      finalized = true;
      try {
        await deps.shutdownAppServices?.();
      } catch (err) {
        deps.log.warn({ err }, "myrmidon(PROCS-1.2): app services shutdown during drain failed");
      }
      deps.exit(0);
    }

    for (const client of deps.wsClients()) {
      try {
        client.close(1012, "process drain");
      } catch (err) {
        deps.log.warn({ err }, "myrmidon(PROCS-1.2): websocket close during drain failed");
      }
    }

    deps.server.close(() => {
      void finalize();
    });
    deps.server.closeIdleConnections();

    deps.setTimeout(() => {
      deps.log.warn({ pid: process.pid }, "myrmidon(PROCS-1.2): drain grace expired — closing every connection");
      deps.server.closeAllConnections();
      void finalize();
    }, graceMs).unref?.();
  });
}
