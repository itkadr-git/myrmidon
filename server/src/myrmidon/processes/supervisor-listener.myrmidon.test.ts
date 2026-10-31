// myrmidon(OPE-10011): the worker's public listener and the api children on
// ONE port, on real sockets — no mocked listen.
//
// What broke on the stand (1.6.6-rc.18): the worker bound :3100 without
// SO_REUSEPORT, so both api children died with `listen EADDRINUSE`; the first
// supervisor apply ran before `app` existed (TDZ) and left the supervisor in
// drainingToSingle, where a later PATCH split was a silent no-op; and with a
// stored split the worker's startup listener was never handed to the
// supervisor, so it was never closed once the children were ready.
//
// The worker side here mirrors server/src/index.ts: openPublicListener waits
// for the startup listener before it may touch the app, the startup listener
// binds with the options the role asks for (`primaryListenReusesPort`) and is
// then adopted by the supervisor. The api children are stand-ins that bind a
// real socket the way the api role does and report ready over the IPC seam.
import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROCESSES_SETTINGS, type ProcessesSettings } from "@myrmidon/shared";
import {
  PROCESS_ROLE_API_HOST,
  primaryListenReusesPort,
  processRoleProfileFor,
  type ProcessRole,
} from "../../services/process-role.js";
import {
  createProcessSupervisor,
  SUPERVISOR_BACKOFF_INITIAL_MS,
  SUPERVISOR_IPC_READY,
  type ProcessSupervisor,
  type ProcessSupervisorDeps,
  type SupervisorListenerHandle,
} from "./supervisor.js";

const describeLinux = process.platform === "linux" ? describe : describe.skip;

/** Every server a test opened; afterEach closes whatever is still up. */
const openServers = new Set<http.Server>();
const supervisors: ProcessSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdown();
  await Promise.all([...openServers].map((server) => closeServer(server)));
  openServers.clear();
});

function settings(patch: Partial<ProcessesSettings>): ProcessesSettings {
  return { ...DEFAULT_PROCESSES_SETTINGS, ...patch };
}

function namedServer(name: string): http.Server {
  const server = http.createServer((_req, res) => {
    res.setHeader("connection", "close");
    res.end(name);
  });
  openServers.add(server);
  return server;
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

/** The primary listen of index.ts for a role: same branch, same options. */
function listenAsRole(server: http.Server, role: ProcessRole, port: number, host: string): Promise<void> {
  const reusePort = primaryListenReusesPort(processRoleProfileFor(role));
  return listen(server, reusePort ? { port, host, reusePort: true } : { port, host });
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
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

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
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

/** An api child stand-in: binds the shared port the way the api role does. */
class SocketChild extends EventEmitter {
  static count = 0;
  readonly pid = 50_000 + ++SocketChild.count;
  readonly name = `child-${SocketChild.count}`;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly server = namedServer(this.name);
  readonly bound: Promise<void>;

  constructor(port: number) {
    super();
    this.bound = listenAsRole(this.server, "api", port, PROCESS_ROLE_API_HOST);
    this.bound.catch(() => undefined); // asserted by the tests, not here
  }

  ready(): void {
    this.emit("message", { type: SUPERVISOR_IPC_READY });
  }

  send(): boolean {
    return true;
  }

  kill(signal = "SIGTERM"): boolean {
    void closeServer(this.server).then(() => {
      this.signalCode = signal;
      this.emit("exit", null, signal);
    });
    return true;
  }

  async crash(): Promise<void> {
    await closeServer(this.server);
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}

/** Timers that never fire: the grace/backoff ladders are not under test here. */
const inertTimers: Pick<ProcessSupervisorDeps, "setTimeout" | "clearTimeout"> = {
  setTimeout: (() => ({ unref: () => undefined })) as unknown as typeof setTimeout,
  clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
};

const silentLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The worker of index.ts in miniature, on a real port. */
function workerStand(
  port: number,
  options: {
    openPublicListener?: ProcessSupervisorDeps["openPublicListener"];
    timers?: Pick<ProcessSupervisorDeps, "setTimeout" | "clearTimeout">;
  } = {},
) {
  const children: SocketChild[] = [];
  const opened: http.Server[] = [];
  let publicServer: http.Server | null = null;
  let appReady = false;
  let markStartupListenerReady: () => void = () => undefined;
  const startupListenerReady = new Promise<void>((resolve) => {
    markStartupListenerReady = resolve;
  });

  const supervisor = createProcessSupervisor({
    openPublicListener:
      options.openPublicListener ??
      (async () => {
        await startupListenerReady;
        if (!appReady) throw new ReferenceError("Cannot access 'app' before initialization");
        if (publicServer?.listening) return handleFor(publicServer);
        const server = namedServer("worker-reopened");
        await listen(server, { host: "0.0.0.0", port, reusePort: true });
        publicServer = server;
        opened.push(server);
        return handleFor(server);
      }),
    drainPublicListener: async (handle) => {
      const server = (handle as SupervisorListenerHandle & { server?: http.Server }).server;
      if (!server) return;
      await closeServer(server);
      if (publicServer === server) publicServer = null;
    },
    forkChild: () => {
      const child = new SocketChild(port);
      children.push(child);
      return child as unknown as ChildProcess;
    },
    log: silentLog,
    ...(options.timers ?? inertTimers),
  });
  supervisors.push(supervisor);

  return {
    supervisor,
    children,
    opened,
    /** createApp, then the startup listen of the worker role, then the hand-over. */
    async bootStartupListener(): Promise<http.Server> {
      appReady = true;
      const server = namedServer("worker");
      await listenAsRole(server, "worker", port, "0.0.0.0");
      publicServer = server;
      markStartupListenerReady();
      await supervisor.adoptPublicListener(handleFor(server));
      return server;
    },
  };
}

describeLinux("worker listener and api children on one port (OPE-10011)", () => {
  it("the worker startup listener and two reusePort listeners bind the same port", async () => {
    const port = await freePort();
    const worker = namedServer("worker");
    await listenAsRole(worker, "worker", port, "0.0.0.0");
    const first = namedServer("child-a");
    const second = namedServer("child-b");
    await listenAsRole(first, "api", port, PROCESS_ROLE_API_HOST);
    // The supervisor's re-open of the worker lane (drain back to single) uses
    // the same reusePort bind as the children.
    await listen(second, { host: "0.0.0.0", port, reusePort: true });

    expect([worker, first, second].map((server) => server.listening)).toEqual([true, true, true]);
    expect([worker, first, second].map((server) => (server.address() as AddressInfo).port)).toEqual([port, port, port]);
    expect(["worker", "child-a", "child-b"]).toContain(await get(port));
  });

  it("control: a first socket without reusePort (the rc.18 worker) locks the children out", async () => {
    const port = await freePort();
    const exclusive = namedServer("all-role");
    await listenAsRole(exclusive, "all", port, "0.0.0.0");
    const child = namedServer("child");
    await expect(listenAsRole(child, "api", port, PROCESS_ROLE_API_HOST)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("apply(single) before the app exists waits for the startup listener; the apply(split) behind it is not lost", async () => {
    const port = await freePort();
    const stand = workerStand(port);
    // startProcessesSettings runs before createApp; a PATCH/bus apply right behind.
    const first = stand.supervisor.apply(settings({ mode: "single" }));
    const second = stand.supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stand.children).toHaveLength(0);

    const worker = await stand.bootStartupListener();
    await first;
    await second;
    expect(stand.supervisor.state()).toBe("startingSplit");
    expect(stand.children).toHaveLength(2);
    // The children join the port the worker already holds — no EADDRINUSE.
    await Promise.all(stand.children.map((child) => child.bound));
    expect(worker.listening).toBe(true);
    expect(stand.opened).toHaveLength(0); // the startup listener served single; nothing re-opened

    for (const child of stand.children) child.ready();
    await waitUntil(() => !worker.listening, "the worker to leave the public port");
    expect(stand.supervisor.state()).toBe("split");
    expect(stand.children.every((child) => child.server.listening)).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(await get(port)).toMatch(/^child-/);
    }
  });

  it("a first apply that throws (the TDZ) rolls back, and the next applies retry", async () => {
    const port = await freePort();
    let calls = 0;
    const reopened: http.Server[] = [];
    const stand = workerStand(port, {
      openPublicListener: async () => {
        calls += 1;
        if (calls === 1) throw new ReferenceError("Cannot access 'app' before initialization");
        const server = namedServer("worker");
        await listen(server, { host: "0.0.0.0", port, reusePort: true });
        reopened.push(server);
        return handleFor(server);
      },
    });

    await expect(stand.supervisor.apply(settings({ mode: "single" }))).rejects.toThrow("before initialization");
    expect(stand.supervisor.state()).toBe("single"); // not stranded in drainingToSingle

    // The same value again is a retry, not a no-op.
    await stand.supervisor.apply(settings({ mode: "single" }));
    expect(calls).toBe(2);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].listening).toBe(true);

    await stand.supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    expect(stand.supervisor.state()).toBe("startingSplit");
    expect(stand.children).toHaveLength(2);
    await Promise.all(stand.children.map((child) => child.bound));
  });

  it("a failed move back to single leaves split in force: a crashed child still restarts", async () => {
    const port = await freePort();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const stand = workerStand(port, {
      openPublicListener: async () => {
        throw new Error("listen EACCES: permission denied 0.0.0.0");
      },
      timers: {
        setTimeout: ((fn: () => void, ms: number) => {
          timers.push({ fn, ms });
          return { unref: () => undefined };
        }) as unknown as typeof setTimeout,
        clearTimeout: (() => undefined) as unknown as typeof clearTimeout,
      },
    });
    await stand.supervisor.apply(settings({ mode: "split", apiCount: 1 }));
    await stand.children[0].bound;
    stand.children[0].ready();
    await waitUntil(() => stand.supervisor.state() === "split", "split");

    await expect(stand.supervisor.apply(settings({ mode: "single" }))).rejects.toThrow("EACCES");
    expect(stand.supervisor.state()).toBe("split");

    await stand.children[0].crash();
    for (const timer of timers.filter((t) => t.ms === SUPERVISOR_BACKOFF_INITIAL_MS)) timer.fn();
    // The supervisor still converges on split(1), so the slot is re-forked.
    expect(stand.children).toHaveLength(2);
    await stand.children[1].bound;
  });

  it("start with a stored split: the startup listener binds after the children and closes once they are ready", async () => {
    const port = await freePort();
    const stand = workerStand(port);
    // startProcessesSettings with a stored split forks before createApp.
    await stand.supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    expect(stand.supervisor.state()).toBe("startingSplit");
    await Promise.all(stand.children.map((child) => child.bound));

    // The worker binds the port the children already hold.
    const worker = await stand.bootStartupListener();
    expect(worker.listening).toBe(true);
    expect(stand.supervisor.state()).toBe("startingSplit");

    for (const child of stand.children) child.ready();
    await waitUntil(() => !worker.listening, "the worker to leave the public port");
    expect(stand.supervisor.state()).toBe("split");
    expect(stand.opened).toHaveLength(0);
    for (let i = 0; i < 5; i += 1) {
      expect(await get(port)).toMatch(/^child-/);
    }
  });

  it("start with a stored split: children ready before the worker bound — the adopted listener closes at once", async () => {
    const port = await freePort();
    const stand = workerStand(port);
    await stand.supervisor.apply(settings({ mode: "split", apiCount: 2 }));
    await Promise.all(stand.children.map((child) => child.bound));
    for (const child of stand.children) child.ready();
    await waitUntil(() => stand.supervisor.state() === "split", "split");

    const worker = await stand.bootStartupListener();
    expect(worker.listening).toBe(false);
    expect(stand.children.every((child) => child.server.listening)).toBe(true);
    expect(await get(port)).toMatch(/^child-/);
  });
});
