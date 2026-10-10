// server/src/__tests__/procs/helpers/api-process-harness.ts
//
// myrmidon(1.6.6 PROCS-T1.5, design BOARD-PROCESSES §7.1): the harness of the
// "two api processes, one database" skeleton. Nothing here is a stub — every
// helper spawns the production entry (`server/src/index.ts`) with the repo's own
// tsx loader and talks to it over HTTP, so a test exercises real processes.
//
// What the two processes share: the database (one connection string). What they
// must NOT share: the instance home — one PAPERCLIP_HOME and one config file per
// process, otherwise both would fight over the same log dir, secret key and
// storage root instead of only over the database.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: <repo>/server/src/__tests__/procs/helpers -> five levels up. */
export const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..", "..", "..", "..");
/** The production entry both processes run. */
export const SERVER_ENTRY = path.join(REPO_ROOT, "server", "src", "index.ts");
/** The worker entry of the split layout (PROCS-1.5 ч.H). */
export const WORKER_ENTRY = path.join(REPO_ROOT, "server", "src", "worker.ts");

/** Readiness budget: a cold tsx boot of the whole server graph is slow on CI. */
export const READY_TIMEOUT_MS = 180_000;
/** How long a draining process may take to leave (design §2.3: drain, then exit). */
export const DRAIN_TIMEOUT_MS = 30_000;
/** Kept per process for failure messages; the tail is what a boot error prints. */
const OUTPUT_TAIL_CHARS = 20_000;

/** Resolves the tsx CLI the same way the rest of the repo does: from the
 * workspace that declares it, falling back to a hoisted install. */
export function resolveTsxCli(): string {
  const candidates = [
    path.join(REPO_ROOT, "server", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`tsx is not installed; looked in:\n${candidates.join("\n")}`);
  }
  return found;
}

/** A free loopback port, so two processes can be started on known distinct
 * ports without racing each other for 3100. */
export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("could not reserve a loopback port"));
      });
    });
  });
}

export type ApiProcessHome = {
  dir: string;
  instanceId: string;
  configPath: string;
};

/** One process = one home + one config file. The config pins
 * `database.mode: "postgres"` with the shared test connection string: that is
 * the single piece of state the two processes share. */
export function createProcessHome(options: {
  baseDir: string;
  index: number;
  port: number;
  connectionString: string;
}): ApiProcessHome {
  const dir = path.join(options.baseDir, `api-${options.index}`);
  const instanceId = `procs-t1-5-${options.index}`;
  fs.mkdirSync(dir, { recursive: true });

  const configPath = path.join(dir, "config.json");
  const config = {
    $meta: { version: 1, updatedAt: new Date().toISOString(), source: "configure" },
    database: {
      mode: "postgres",
      connectionString: options.connectionString,
      // The skeleton asserts the serving path, not the backup scheduler.
      backup: { enabled: false },
    },
    logging: { mode: "file", logDir: path.join(dir, "logs") },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: options.port,
      // No UI build and no vite dev middleware: an api process serves HTTP.
      serveUi: false,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: false },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { dir, instanceId, configPath };
}
export type ApiProcessHandle = {
  index: number;
  role: string;
  port: number;
  baseUrl: string;
  home: ApiProcessHome;
  child: ChildProcess;
  /** Everything the process printed so far (stdout + stderr), tail-bounded. */
  output: () => string;
  /** True while the OS process has not exited yet. */
  alive: () => boolean;
};

/** A worker process handle: same shape as an api handle, but the port is the
 * loopback readiness probe, not the public API. */
export type WorkerProcessHandle = ApiProcessHandle;

/** Env keys the harness owns: the child must see its own instance, its own port
 * and the shared database — never the values of the process that runs the tests
 * (a developer shell may carry a real PAPERCLIP_API_KEY/PAPERCLIP_API_URL, and
 * inheriting those would make a test process talk to a live board). */
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

function childEnv(handle: {
  home: ApiProcessHome;
  port: number;
  connectionString: string;
  role: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of OWNED_ENV_KEYS) delete env[key];
  return {
    ...env,
    NODE_ENV: process.env.NODE_ENV ?? "test",
    PORT: String(handle.port),
    PAPERCLIP_HOME: handle.home.dir,
    PAPERCLIP_INSTANCE_ID: handle.home.instanceId,
    PAPERCLIP_CONFIG: handle.home.configPath,
    DATABASE_URL: handle.connectionString,
    // The api role of the split layout (design §2.1): this process serves HTTP
    // and, once the role gate of that layout lands, owns no background timers.
    PAPERCLIP_PROCESS_ROLE: handle.role,
    // The test fixture applied every migration before the processes started, so
    // an api process must never migrate and never race another one for the
    // schema (design §2.3: migrations belong to the worker).
    PAPERCLIP_MIGRATION_PROMPT: "never",
    SERVE_UI: "false",
    PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
    PAPERCLIP_OPEN_ON_LISTEN: "false",
  };
  if (handle.role === "worker") {
    // The worker's loopback probe (ч.H): the board config above still binds
    // its own listener on PORT, so the probe must not fight it for the port.
    env.MYRMIDON_WORKER_PORT = String(handle.port);
  }
  return env;
}

export type StartApiProcessOptions = {
  baseDir: string;
  index: number;
  connectionString: string;
  role?: string;
  port?: number;
  /** Readiness budget override. */
  readyTimeoutMs?: number;
  /** Entry point override (worker.ts for the worker role). */
  entry?: string;
  /** Probe path the harness waits on (the worker answers /internal/ready). */
  readyPath?: string;
};

/** Spawns one `api` process and waits until it answers `/api/health` with 200.
 * Throws with the process output tail when it exits early or never becomes
 * ready — a silent "boot failed" would make the whole skeleton lie. */
export async function startApiProcess(
  options: StartApiProcessOptions,
): Promise<ApiProcessHandle> {
  const port = options.port ?? (await pickFreePort());
  const role = options.role ?? "api";
  const home = createProcessHome({
    baseDir: options.baseDir,
    index: options.index,
    port,
    connectionString: options.connectionString,
  });

  const child = spawn(process.execPath, [resolveTsxCli(), options.entry ?? SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: childEnv({ home, port, connectionString: options.connectionString, role }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const capture = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const handle: ApiProcessHandle = {
    index: options.index,
    role,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    home,
    child,
    output: () => output,
    alive: () => child.exitCode === null && child.signalCode === null,
  };

  try {
    await waitForReady(handle, options.readyTimeoutMs ?? READY_TIMEOUT_MS, options.readyPath ?? "/api/health");
  } catch (error) {
    await killApiProcess(handle);
    throw error;
  }
  return handle;
}

/** Polls `/api/health` until it answers 200. Any other answer (or a refused
 * connection) means "not listening yet", which is the normal state during a
 * cold boot. */
export async function waitForReady(
  handle: Pick<ApiProcessHandle, "baseUrl" | "alive" | "output">,
  timeoutMs: number,
  readyPath = "/api/health",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    if (!handle.alive()) {
      throw new Error(
        `process exited before it became ready:\n${handle.output()}`,
      );
    }
    try {
      const response = await fetch(`${handle.baseUrl}${readyPath}`);
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(
    `process did not answer ${readyPath} within ${timeoutMs}ms (last: ${lastError})\n${handle.output()}`,
  );
}

export type JsonHttpResponse = {
  status: number;
  text: string;
  json: unknown;
};

/** One HTTP request against one process. The port identifies the process: each
 * process of this skeleton listens on its own port (the shared-port reusePort
 * layout is stage-1 part B, owned by another issue). */
export async function requestApi(
  baseUrl: string,
  pathname: string,
  init: RequestInit = {},
): Promise<JsonHttpResponse> {
  const response = await fetch(new URL(pathname, baseUrl), init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

/** SIGTERM, then SIGKILL if the process overruns the drain budget. Returns the
 * exit evidence so a test can assert the drain instead of assuming it. */
export async function stopApiProcess(
  handle: ApiProcessHandle,
  options: { signal?: NodeJS.Signals; timeoutMs?: number } = {},
): Promise<{ drained: boolean; code: number | null; signal: NodeJS.Signals | null; durationMs: number }> {
  const signal = options.signal ?? "SIGTERM";
  const timeoutMs = options.timeoutMs ?? DRAIN_TIMEOUT_MS;
  const startedAt = Date.now();

  if (!handle.alive()) {
    return { drained: true, code: handle.child.exitCode, signal: handle.child.signalCode, durationMs: 0 };
  }
  const exited = new Promise<void>((resolve) => handle.child.once("exit", () => resolve()));
  handle.child.kill(signal);
  const drained = await Promise.race([
    exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (!drained) {
    handle.child.kill("SIGKILL");
    await exited;
  }
  return {
    drained,
    code: handle.child.exitCode,
    signal: handle.child.signalCode,
    durationMs: Date.now() - startedAt,
  };
}

/** Best-effort teardown for afterAll: never throws, never leaves an orphan. */
async function killApiProcess(handle: ApiProcessHandle): Promise<void> {
  try {
    await stopApiProcess(handle, { timeoutMs: 5_000 });
  } catch {
    // best effort only
  }
}

export async function stopApiProcesses(handles: ApiProcessHandle[]): Promise<void> {
  for (const handle of handles) {
    await killApiProcess(handle);
  }
}

/** The two-process fixture of this skeleton: N api processes, one database. */
export async function startApiProcesses(options: {
  count: number;
  baseDir: string;
  connectionString: string;
  role?: string;
  readyTimeoutMs?: number;
}): Promise<ApiProcessHandle[]> {
  const ports = await Promise.all(
    Array.from({ length: options.count }, () => pickFreePort()),
  );
  const handles: ApiProcessHandle[] = [];
  for (let index = 0; index < options.count; index += 1) {
    handles.push(
      await startApiProcess({
        baseDir: options.baseDir,
        index,
        connectionString: options.connectionString,
        port: ports[index],
        role: options.role,
        readyTimeoutMs: options.readyTimeoutMs,
      }),
    );
  }
  return handles;
}