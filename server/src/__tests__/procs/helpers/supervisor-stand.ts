// server/src/__tests__/procs/helpers/supervisor-stand.ts
//
// myrmidon(1.6.6 PROCS-1.9, OPE-5415): the stand of the single <-> split
// scenario (T7). The REAL process supervisor (PROCS-1.2) is held by the test
// process and forks REAL api children of the production entry point against a
// real database, the same way the drain/failover suite does. The worker's own
// public listener is an HTTP probe that answers /api/health on the shared
// port: it plays the `single` lane, so a request that lands on it is a request
// the worker would have served.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  createProcessSupervisor,
  type ProcessSupervisor,
  type SupervisorListenerHandle,
} from "../../../myrmidon/processes/index.js";
import { createProcessHome, REPO_ROOT, resolveTsxCli, SERVER_ENTRY } from "./api-process-harness.js";

/** The public port the api children share; the supervisor pins it as a constant. */
export const STAND_BOARD_PORT = 3100;
export const STAND_BOARD_URL = `http://127.0.0.1:${STAND_BOARD_PORT}`;

const OWNED_ENV_KEYS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_HOME",
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_PROCESS_ROLE",
  "PAPERCLIP_MIGRATION_AUTO_APPLY",
  "PAPERCLIP_MIGRATION_PROMPT",
  "DATABASE_URL",
  "PORT",
] as const;

export type SupervisorStand = {
  supervisor: ProcessSupervisor;
  /** True while the probe (the worker's single lane) holds the shared port. */
  probeListening: () => boolean;
  /** Tail of the children's output, for failure messages. */
  childOutput: () => string;
  /** Stops the supervisor, kills every forked pid and closes the probe. */
  stop: () => Promise<void>;
};

function resolveTsxLoader(): string {
  const candidates = [
    path.join(REPO_ROOT, "server", "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "loader.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ?? path.join(path.dirname(resolveTsxCli()), "loader.mjs");
}

export function startSupervisorStand(options: { baseDir: string; connectionString: string }): SupervisorStand {
  const tsxLoader = resolveTsxLoader();
  const forkedPids: number[] = [];
  const childLogs: string[] = [];
  let childIndex = 0;
  let probeServer: http.Server | null = null;

  const openProbeListener = (): Promise<SupervisorListenerHandle> =>
    new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");
        res.end(JSON.stringify({ status: "ok", lane: "single-probe", url: req.url }));
      });
      server.once("error", reject);
      server.listen({ host: "0.0.0.0", port: STAND_BOARD_PORT, reusePort: true }, () => {
        probeServer = server;
        resolve({
          get listening() {
            return server.listening;
          },
          close: () =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
              server.closeIdleConnections();
            }),
          closeIdleConnections: () => server.closeIdleConnections(),
          closeAllConnections: () => server.closeAllConnections(),
        });
      });
    });

  const supervisor = createProcessSupervisor({
    openPublicListener: openProbeListener,
    drainPublicListener: async (handle) => {
      await handle.close();
      handle.closeIdleConnections();
      handle.closeAllConnections();
      probeServer = null;
    },
    forkChild: (env, execArgv) => {
      const index = ++childIndex;
      const home = createProcessHome({
        baseDir: options.baseDir,
        index,
        port: STAND_BOARD_PORT,
        connectionString: options.connectionString,
      });
      const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
      for (const key of OWNED_ENV_KEYS) delete cleanEnv[key];
      const child = fork(SERVER_ENTRY, [], {
        cwd: REPO_ROOT,
        env: {
          ...cleanEnv,
          ...env,
          NODE_ENV: process.env.NODE_ENV ?? "test",
          PORT: String(STAND_BOARD_PORT),
          PAPERCLIP_HOME: home.dir,
          PAPERCLIP_INSTANCE_ID: home.instanceId,
          PAPERCLIP_CONFIG: home.configPath,
          DATABASE_URL: options.connectionString,
          PAPERCLIP_PROCESS_ROLE: "api",
          PAPERCLIP_MIGRATION_PROMPT: "never",
          SERVE_UI: "false",
          PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
          PAPERCLIP_OPEN_ON_LISTEN: "false",
        },
        execArgv: [
          ...execArgv,
          "--import",
          "data:text/javascript,if(typeof%20process.send==='function')process.send=process.send.bind(process);",
          "--import",
          pathToFileURL(tsxLoader).href,
          "--max-old-space-size=1024",
        ],
        silent: true,
      });
      const record = (chunk: Buffer) => {
        childLogs.push(`[child#${index}] ${chunk.toString("utf8")}`);
        if (childLogs.length > 100) childLogs.shift();
      };
      child.stdout?.on("data", record);
      child.stderr?.on("data", record);
      if (child.pid) forkedPids.push(child.pid);
      return child;
    },
    setTimeout,
    clearTimeout,
    log: {
      debug: () => undefined,
      info: (fields: object, message: string) => console.log(`[supervisor:info] ${message}`, fields),
      warn: (fields: object, message: string) => console.warn(`[supervisor:warn] ${message}`, fields),
      error: (fields: object, message: string) => console.error(`[supervisor:error] ${message}`, fields),
    },
  });

  return {
    supervisor,
    probeListening: () => probeServer?.listening === true,
    childOutput: () => childLogs.slice(-25).join(""),
    stop: async () => {
      await supervisor.shutdown();
      for (const pid of forkedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already exited
        }
      }
      const server = probeServer as http.Server | null;
      if (server?.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
  };
}
