// myrmidon(OPE-10011): the api child -> worker IPC on REAL forked processes.
//
// On the stand (1.6.6-rc.18 + the first hotfix) the api children bound :3100
// but never reported ready: `ipcSend` called `process.send` unbound, Node's
// send reads `this.connected` and threw a TypeError, and the catch swallowed
// it — no "reported ready" line, no "probe failed" line, and the worker hung in
// startingSplit. The e2e harnesses masked it with a `--import` that pre-bound
// `process.send`; nothing here does.
//
// The child is a small script run through the tsx loader. It imports the real
// `child.ts` (reportReadyToSupervisor + wireSupervisorDrainHandler) and binds
// the shared port the way the api role does; the supervisor is the real one.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROCESSES_SETTINGS, type ProcessesSettings } from "@myrmidon/shared";
import { primaryListenReusesPort, processRoleProfileFor } from "../../services/process-role.js";
import {
  createProcessSupervisor,
  SUPERVISOR_IPC_READY,
  type ProcessSupervisor,
  type SupervisorListenerHandle,
} from "./supervisor.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..", "..", "..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..");
const CHILD_MODULE_URL = pathToFileURL(path.join(HERE, "child.ts")).href;

function tsxLoaderUrl(): string {
  const candidates = [
    path.join(SERVER_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "loader.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`tsx loader not found in ${candidates.join(", ")}`);
  return pathToFileURL(found).href;
}

const CHILD_SCRIPT = `
import http from "node:http";
const { reportReadyToSupervisor, wireSupervisorDrainHandler } = await import(process.env.OPE10011_CHILD_MODULE);
const port = Number(process.env.OPE10011_PORT ?? "0");
const server = http.createServer((_req, res) => {
  res.setHeader("connection", "close");
  res.end("child-" + process.pid);
});
if (port > 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "0.0.0.0", port, reusePort: true }, resolve);
  });
}
wireSupervisorDrainHandler({
  server,
  wsClients: () => [],
  exit: (code) => process.exit(code),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  log: { info: () => {}, warn: () => {} },
});
const sent = reportReadyToSupervisor();
process.send({ type: "ope10011:probe", sent });
if (port === 0) process.disconnect();
`;

const tempDirs: string[] = [];
const forked: ChildProcess[] = [];
const servers = new Set<http.Server>();
const supervisors: ProcessSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  for (const child of forked.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all([...servers].map(closeServer));
  servers.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function childScriptPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ope10011-child-"));
  tempDirs.push(dir);
  const file = path.join(dir, "api-child.mjs");
  fs.writeFileSync(file, CHILD_SCRIPT);
  return file;
}

function forkApiChild(script: string, port: number, output: string[]): ChildProcess {
  const child = fork(script, [], {
    execArgv: ["--import", tsxLoaderUrl()],
    env: {
      ...process.env,
      NODE_ENV: "production", // plain pino on stdout, no transport thread
      OPE10011_CHILD_MODULE: CHILD_MODULE_URL,
      OPE10011_PORT: String(port),
    },
    silent: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
  forked.push(child);
  return child;
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function listen(server: http.Server, options: { port: number; host: string; reusePort?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await listen(probe, { port: 0, host: "0.0.0.0" });
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false, headers: { connection: "close" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function waitUntil(check: () => boolean, label: string, output: string[] = [], timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}\n--- child output ---\n${output.join("").slice(-3000)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function handleFor(server: http.Server): SupervisorListenerHandle & { server: http.Server } {
  return {
    server,
    get listening() {
      return server.listening;
    },
    close: () => closeServer(server),
    closeIdleConnections: () => server.closeIdleConnections(),
    closeAllConnections: () => server.closeAllConnections(),
  };
}

function settings(patch: Partial<ProcessesSettings>): ProcessesSettings {
  return { ...DEFAULT_PROCESSES_SETTINGS, ...patch };
}

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("api child IPC on real processes (OPE-10011)", () => {
  it("a forked child's reportReadyToSupervisor() reaches the parent", async () => {
    const output: string[] = [];
    const messages: Array<{ type?: string; pid?: number; sent?: boolean }> = [];
    const child = forkApiChild(childScriptPath(), 0, output);
    child.on("message", (message) => messages.push(message as { type?: string }));
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

    await waitUntil(() => messages.some((m) => m.type === "ope10011:probe"), "the probe message", output);
    expect(messages.find((m) => m.type === "ope10011:probe")?.sent).toBe(true);
    expect(messages.find((m) => m.type === SUPERVISOR_IPC_READY)).toMatchObject({ type: SUPERVISOR_IPC_READY, pid: child.pid });
    expect(await exited).toBe(0);
    expect(output.join("")).toContain("api child reported ready to the worker");
  }, 60_000);

  it("the real supervisor reaches split with forked children on the shared port, and drains them back to single", async () => {
    const port = await freePort();
    const script = childScriptPath();
    const output: string[] = [];
    const children: ChildProcess[] = [];
    let workerServer: http.Server | null = null;
    const attention: unknown[] = [];

    const named = (name: string) => {
      const server = http.createServer((_req, res) => {
        res.setHeader("connection", "close");
        res.end(name);
      });
      servers.add(server);
      return server;
    };

    const supervisor = createProcessSupervisor({
      forkChild: () => {
        const child = forkApiChild(script, port, output);
        children.push(child);
        return child;
      },
      openPublicListener: async () => {
        if (workerServer?.listening) return handleFor(workerServer);
        const server = named("worker");
        await listen(server, { host: "0.0.0.0", port, reusePort: true });
        workerServer = server;
        return handleFor(server);
      },
      drainPublicListener: async (handle) => {
        const server = (handle as SupervisorListenerHandle & { server?: http.Server }).server;
        if (server) await closeServer(server);
        if (workerServer === server) workerServer = null;
      },
      writeAttentionSignal: (details) => attention.push(details),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    supervisors.push(supervisor);

    // The worker's startup listener (role options), handed to the supervisor.
    const startup = named("worker");
    const workerProfile = processRoleProfileFor("worker");
    await listen(startup, primaryListenReusesPort(workerProfile) ? { port, host: "0.0.0.0", reusePort: true } : { port, host: "0.0.0.0" });
    workerServer = startup;
    await supervisor.apply(settings({ mode: "single" }));
    await supervisor.adoptPublicListener(handleFor(startup));

    await supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    expect(supervisor.state()).toBe("startingSplit");
    await waitUntil(() => supervisor.state() === "split", "split in force (both children ready over IPC)", output);
    await waitUntil(() => !startup.listening, "the worker to leave the public port", output);
    for (let i = 0; i < 4; i += 1) {
      expect(await get(port)).toMatch(/^child-\d+$/);
    }
    expect(attention).toHaveLength(0);

    await supervisor.apply(settings({ mode: "single" }));
    expect(supervisor.state()).toBe("single");
    await waitUntil(() => children.every((child) => child.exitCode !== null || child.signalCode !== null), "the drained children to exit", output);
    expect(children.map((child) => child.exitCode)).toEqual([0, 0]);
    expect(await get(port)).toBe("worker");
  }, 90_000);
});
