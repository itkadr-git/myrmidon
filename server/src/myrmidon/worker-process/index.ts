// server/src/myrmidon/worker-process/index.ts
//
// myrmidon(1.6.6 PROCS-1.5 ч.H, design BOARD-PROCESSES §2.1): the standalone
// worker runtime — the heartbeat executor and every background sweep of the
// board, running in its own process without the public API surface.
//
// Launch contract: `PAPERCLIP_PROCESS_ROLE=worker` (written by the launch
// map of ч.E / PROCS-T1.5), the loopback probe on `MYRMIDON_WORKER_PORT`.
// ч.A (OPE-6956, the settings-schema source of the role config) was cancelled
// as a duplicate of PR #996, so this entry reads the minimal local contract:
// `PAPERCLIP_PROCESS_ROLE` from the process registry (PROCS-0.1) and
// `MYRMIDON_WORKER_PROCESSES` (count, default 1) with
// `MYRMIDON_WORKER_QUEUES` left to its owner (ч.B/ч.E); an M>1 launch is
// logged as off-recommendation because stage 1 keeps a single executor.
//
// What the worker runs: the same `startServer()` startup as today's single
// process — heartbeat service, execution-control sweeps, startup recovery,
// the process-registry pulse with role `worker` and `apiPort: null`. The
// readiness surface is the ч.F contract itself: the same
// `myrmidonProcessReadinessRoutes` (database, migrations, bus) mounted on a
// loopback-only listener, because a balancer and the container runtime probe
// every process role by the same paths — `/internal/ready` and `/healthz`.
// The public API app of the board still binds its own port inside
// `startServer()` (hot-restart adoption and the plugin worker lanes listen on
// it); the worker registers with `apiPort: null`, so no balancer ever sends
// board traffic there.
//
// `PAPERCLIP_PROCESS_ROLE` unset/invalid → the process refuses to start as a
// worker (exit 1): a mislaunched worker would double every background sweep
// against the api process, and a loud refusal beats a quiet duplicate.

import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import type { Db } from "@paperclipai/db";
import { loadConfig } from "../../config.js";
import { logger } from "../../middleware/logger.js";
import {
  BOARD_PROCESS_ROLES,
  resolveBoardProcessRole,
} from "../process-registry/domain.js";
import { myrmidonProcessReadinessRoutes } from "../process-readiness/index.js";

/** Default port of the worker loopback listener: the board's 3100 + 1, the
 * design §2.1 value for the single worker. */
export const WORKER_DEFAULT_PORT = 3101;

/** Bound of the worker count of the minimal local config (design §2.1: one
 * executor in stage 1; the dev stand of ч.E allows two). */
export const WORKER_COUNT_MAX = 2;

export type WorkerProcessConfig = {
  role: "worker";
  host: string;
  port: number;
  /** `MYRMIDON_WORKER_PROCESSES` (M), 1 when unset. */
  workerCount: number;
};

/** Reads the minimal local worker config. Throws with an operator-readable
 * message when the process was not launched as a worker. */
export function resolveWorkerProcessConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerProcessConfig {
  const role = resolveBoardProcessRole(env.PAPERCLIP_PROCESS_ROLE);
  if (role !== "worker") {
    throw new Error(
      `worker-process: refusing to start — PAPERCLIP_PROCESS_ROLE must be "worker" ` +
        `(got ${JSON.stringify(env.PAPERCLIP_PROCESS_ROLE ?? "<unset>")}); ` +
        `valid roles: ${BOARD_PROCESS_ROLES.join(", ")}. ` +
        `Without the role gate this process would run the whole background ` +
        `workload twice against the api process.`,
    );
  }
  const workerCountRaw = (env.MYRMIDON_WORKER_PROCESSES ?? "").trim();
  const workerCount = workerCountRaw ? Number(workerCountRaw) : 1;
  if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > WORKER_COUNT_MAX) {
    throw new Error(
      `worker-process: MYRMIDON_WORKER_PROCESSES must be an integer 1..${WORKER_COUNT_MAX} ` +
        `(got ${JSON.stringify(workerCountRaw)})`,
    );
  }
  if (workerCount > 1) {
    logger.warn(
      { workerCount },
      "worker-process: MYRMIDON_WORKER_PROCESSES > 1 is the dev-stand shape; " +
        "stage 1 keeps a single run executor (design BOARD-PROCESSES §2.1)",
    );
  }
  return {
    role,
    host: (env.MYRMIDON_WORKER_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: Number(env.MYRMIDON_WORKER_PORT ?? env.PORT) || WORKER_DEFAULT_PORT,
    workerCount,
  };
}

export type WorkerProcess = {
  /** The loopback app with the ч.F readiness routes. */
  app: Express;
  /** The listening HTTP server of the readiness probe. */
  listener: Server;
  /** Stops the probe listener; the board runtime underneath is shut down by
   * the caller's `StartedServer.shutdown()`. */
  close(): Promise<void>;
};

/** Builds the worker's loopback app: nothing but the ч.F readiness routes.
 * Kept separate from the board's express app on purpose — the worker must
 * not mount the public API surface on its own port; the readiness router
 * answers only `/internal/ready` and `/healthz`. */
export function createWorkerReadinessApp(options: { db: Db }): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(myrmidonProcessReadinessRoutes(options.db));
  return app;
}

/** Starts the loopback readiness listener of a worker process. */
export async function startWorkerReadinessListener(options: {
  config: WorkerProcessConfig;
  db: Db;
}): Promise<WorkerProcess> {
  const app = createWorkerReadinessApp({ db: options.db });
  const listener = createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      listener.off("error", onError);
      rejectListen(err);
    };
    listener.once("error", onError);
    listener.listen(options.config.port, options.config.host, () => {
      listener.off("error", onError);
      resolveListen();
    });
  });
  logger.info(
    { host: options.config.host, port: options.config.port, role: "worker" },
    "worker-process: readiness probe listening",
  );
  return {
    app,
    listener,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        listener.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

/** Standalone entry: enforces the role gate, loads the board config, starts
 * the board runtime with the worker role, and wires the readiness probe.
 * The heavy lifting stays in `startServer()` of server/src/index.ts so the
 * single-process default keeps byte-for-byte today's behaviour. */
export async function startWorkerProcess(options: {
  env?: NodeJS.ProcessEnv;
}): Promise<{ close: () => Promise<void> }> {
  const workerConfig = resolveWorkerProcessConfig(options.env ?? process.env);
  // The board config validates DATABASE_URL etc.; load it before startServer
  // so a misconfigured worker fails fast with the same message the api would.
  loadConfig();
  const { startServer } = await import("../../index.js");
  const started = await startServer();
  if (started.processRole !== "worker" || !started.ownsBackgroundWork) {
    throw new Error(
      `worker-process: startServer came up with role ${started.processRole} ` +
        `(ownsBackgroundWork=${started.ownsBackgroundWork}); the role gate is broken`,
    );
  }
  const probe = await startWorkerReadinessListener({
    config: workerConfig,
    db: started.db,
  });
  const close = async () => {
    await probe.close().catch((err) => logger.warn({ err }, "worker-process: probe close failed"));
    await started.shutdown("SIGTERM");
  };
  return { close };
}
