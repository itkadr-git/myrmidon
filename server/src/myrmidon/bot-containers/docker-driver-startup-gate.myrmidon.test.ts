/**
 * OPE-10801 — 1.6.7 GATEWAY-RESTART: isolated test for per-host integrity-check
 * semaphore and lease behavior.
 *
 * Acceptance criteria covered:
 *  1. K-concurrency bound: the host start semaphore caps concurrent container
 *     starts at K (default 2, configurable via MYRMIDON_MAX_CONCURRENT_STARTS).
 *  2. Active lease prevents timeout restart: while the gateway holds an active
 *     startup-progress-lease.json with phase "state_db_unclean_integrity_check",
 *     the health-startup deadline is extended and the container is not restarted
 *     on timeout.
 *
 * This test is fully self-contained: it uses a minimal fake Docker daemon over a
 * UNIX socket (the same pattern as docker-driver.myrmidon.test.ts) and does NOT
 * import or modify the existing test file.
 *
 * The implementation under review (docker-driver.ts) is NOT modified here.
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSemaphore, dockerBotContainerDriver, DEFAULT_MAX_CONCURRENT_STARTS } from "./docker-driver.js";
import type { BotContainerDriver } from "./driver.js";
import { BOT_RUNTIME_CONTRACT_LABEL } from "./template.js";

// ---------------------------------------------------------------------------
// Pure unit: createSemaphore K-bound
// ---------------------------------------------------------------------------

describe("createSemaphore (OPE-10801)", () => {
  it("enforces K-concurrency bound: at most K acquires are active simultaneously", async () => {
    const K = 2;
    const sem = createSemaphore(K);
    let active = 0;
    let maxActive = 0;

    async function worker(id: number) {
      const release = await sem.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      release();
    }

    await Promise.all([worker(1), worker(2), worker(3), worker(4), worker(5)]);
    expect(maxActive).toBeLessThanOrEqual(K);
    expect(maxActive).toBe(K);
  });

  it("default max concurrent starts is 2", () => {
    expect(DEFAULT_MAX_CONCURRENT_STARTS).toBe(2);
  });

  it("semaphore is fair: queued acquires proceed in order", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];

    async function worker(id: number) {
      const release = await sem.acquire();
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      release();
    }

    await Promise.all([worker(1), worker(2), worker(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Minimal fake Docker daemon (self-contained for OPE-10801)
// ---------------------------------------------------------------------------

interface FakeContainer {
  id: string;
  name: string;
  body: {
    Image: string;
    Env?: string[];
    Labels?: Record<string, string>;
    HostConfig: { Binds: string[]; NetworkMode?: string };
  };
  state: "created" | "running" | "exited" | "dead";
  health?: "starting" | "healthy" | "unhealthy";
  exitCode: number;
}

interface FakeDaemon {
  socketPath: string;
  containers: Map<string, FakeContainer>;
  options: {
    healthOnStart: "starting" | "healthy" | "unhealthy" | null;
  };
  close(): Promise<void>;
}

async function startFakeDaemon(tmp: string): Promise<FakeDaemon> {
  const socketPath = path.join(tmp, "docker.sock");
  const containers = new Map<string, FakeContainer>();
  const options: FakeDaemon["options"] = { healthOnStart: "healthy" };
  let seq = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname;
    const segments = route.split("/").filter(Boolean);
    // Strip Docker API version prefix (e.g. /v1.45/...)
    if (segments.length > 0 && /^v\d+\.\d+$/.test(segments[0])) {
      segments.shift();
    }

    function json(status: number, body: unknown) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    }

    // GET /containers/{name}/json
    if (req.method === "GET" && segments.length === 3 && segments[0] === "containers" && segments[2] === "json") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      return json(200, {
        Id: c.id,
        Name: `/${c.name}`,
        Image: c.body.Image,
        Config: { Image: c.body.Image, Env: c.body.Env, Labels: c.body.Labels },
        HostConfig: { Binds: c.body.HostConfig.Binds, NetworkMode: c.body.HostConfig.NetworkMode },
        State: {
          Status: c.state,
          Running: c.state === "running",
          ExitCode: c.exitCode,
          Health: c.health ? { Status: c.health } : undefined,
        },
      });
    }

    // POST /containers/create?name={name}
    if (req.method === "POST" && segments.length === 2 && segments[0] === "containers" && segments[1] === "create") {
      const name = url.searchParams.get("name") ?? `container-${++seq}`;
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const existing = containers.get(name);
        if (existing) return json(409, { message: "Conflict" });
        const container: FakeContainer = {
          id: `fake-${++seq}`,
          name,
          body: {
            Image: parsed.Image ?? "",
            Env: parsed.Env,
            Labels: parsed.Labels,
            HostConfig: { Binds: parsed.HostConfig?.Binds ?? [], NetworkMode: parsed.HostConfig?.NetworkMode },
          },
          state: "created",
          health: options.healthOnStart ? options.healthOnStart : "healthy",
          exitCode: 0,
        };
        containers.set(name, container);
        json(201, { Id: container.id });
      });
      return;
    }

    // POST /containers/{name}/start
    if (req.method === "POST" && segments.length === 3 && segments[0] === "containers" && segments[2] === "start") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      if (c.state === "running") return json(304, {});
      c.state = "running";
      return json(204, null);
    }

    // POST /containers/{name}/stop
    if (req.method === "POST" && segments.length === 3 && segments[0] === "containers" && segments[2] === "stop") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      c.state = "exited";
      return json(204, null);
    }

    // DELETE /containers/{name}
    if (req.method === "DELETE" && segments.length === 2 && segments[0] === "containers") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      if (c.state === "running") return json(409, { message: "Conflict" });
      containers.delete(name);
      return json(204, null);
    }

    // PUT /containers/{name}/archive?path={path}
    if (req.method === "PUT" && segments.length === 3 && segments[0] === "containers" && segments[2] === "archive") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      // Consume the request body (the tar archive) without storing it
      req.on("data", () => {});
      req.on("end", () => json(200, null));
      return;
    }

    // POST /containers/{name}/wait?condition=not-running
    if (req.method === "POST" && segments.length === 3 && segments[0] === "containers" && segments[2] === "wait") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      // Helper containers: mark as exited immediately with success
      c.state = "exited";
      c.exitCode = 0;
      return json(200, { StatusCode: 0 });
    }

    // GET /containers/{name}/logs
    if (req.method === "GET" && segments.length === 3 && segments[0] === "containers" && segments[2] === "logs") {
      const name = decodeURIComponent(segments[1]);
      const c = containers.get(name);
      if (!c) return json(404, { message: "No such container" });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("");
      return;
    }

    // GET /images/{ref}/json
    if (req.method === "GET" && segments.length === 3 && segments[0] === "images" && segments[2] === "json") {
      const ref = decodeURIComponent(segments[1]);
      if (ref.startsWith("myrmidon-hermes:")) {
        return json(200, {
          Id: `sha256:${Buffer.from(ref, "utf8").toString("hex")}`,
          Config: {
            Labels: {
              [BOT_RUNTIME_CONTRACT_LABEL]: "1",
              "org.myrmidon.bot-runtime-scope": "1",
            },
          },
        });
      }
      return json(404, { message: "No such image" });
    }

    // Everything else → 404
    json(404, { message: `Unhandled: ${req.method} ${route}` });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    containers,
    options,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Integration: lease-aware health timeout + host semaphore via driver
// ---------------------------------------------------------------------------

describe("dockerBotContainerDriver — integrity-check semaphore & lease (OPE-10801)", () => {
  let tmp: string;
  let daemon: FakeDaemon;
  let volumesRoot: string;

  beforeEach(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myr-lease-")));
    daemon = await startFakeDaemon(tmp);
    volumesRoot = path.join(tmp, "bots");
  });

  afterEach(async () => {
    await daemon.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const bot = (key = "agent-a") => daemon.containers.get(`myrmidon-bot-${key}`);

  async function createBot(driver: BotContainerDriver, key = "agent-a") {
    await driver.create({
      botKey: key,
      image: "myrmidon-hermes:1.1.0",
      network: "myrmidon-bots",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 100,
      allowlist: ["myrmidon-hermes:*"],
      mountSources: [],
      devbuild: { host: null, user: "", base: "" },
    });
  }

  async function writeLease(botKey: string, phase: string, renewedAtSec: number, expectedS: number) {
    const leaseDir = path.join(volumesRoot, botKey, "hermes", "state");
    await mkdir(leaseDir, { recursive: true });
    await writeFile(
      path.join(leaseDir, "startup-progress-lease.json"),
      JSON.stringify({ phase, renewed_at: renewedAtSec, expected_s: expectedS }),
    );
  }

  async function removeLease(botKey: string) {
    await unlink(path.join(volumesRoot, botKey, "hermes", "state", "startup-progress-lease.json")).catch(() => {});
  }

  it("active integrity-check lease prevents health-timeout restart", async () => {
    let elapsed = 0;
    let wallClock = 1_000_000;
    daemon.options.healthOnStart = "starting";

    const boundedDriver = dockerBotContainerDriver(
      {
        socketPath: daemon.socketPath,
        volumeRoot: volumesRoot,
        network: "myrmidon-bots",
        allowlist: ["myrmidon-hermes:*"],
        mountSources: [],
        devbuild: { host: null, user: "", base: "" },
      },
      {
        startHealthTimeoutMs: 12_000,
        healthPollIntervalMs: 5_000,
        clock: () => wallClock,
        monotonicClock: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          wallClock += ms;
          if (elapsed < 25_000) {
            await writeLease("agent-a", "state_db_unclean_integrity_check", wallClock / 1000, 900);
          } else {
            await removeLease("agent-a");
            daemon.options.healthOnStart = "healthy";
            const c = bot();
            if (c) c.health = "healthy";
          }
        },
      },
    );

    await createBot(boundedDriver);
    await boundedDriver.start("agent-a");

    expect(elapsed).toBeGreaterThanOrEqual(25_000);
    expect(bot()?.state).toBe("running");
    expect(bot()?.health).toBe("healthy");
  });

  it("stale lease (renewed too long ago) does NOT prevent health-timeout restart", async () => {
    let elapsed = 0;
    let wallClock = 1_000_000;
    daemon.options.healthOnStart = "starting";

    const boundedDriver = dockerBotContainerDriver(
      {
        socketPath: daemon.socketPath,
        volumeRoot: volumesRoot,
        network: "myrmidon-bots",
        allowlist: ["myrmidon-hermes:*"],
        mountSources: [],
        devbuild: { host: null, user: "", base: "" },
      },
      {
        startHealthTimeoutMs: 12_000,
        healthPollIntervalMs: 5_000,
        clock: () => wallClock,
        monotonicClock: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
          wallClock += ms;
          await writeLease("agent-a", "state_db_unclean_integrity_check", wallClock / 1000 - 2000, 900);
        },
      },
    );

    await createBot(boundedDriver);
    await expect(boundedDriver.start("agent-a")).rejects.toThrow(/did not become healthy within 12000ms/);
    expect(elapsed).toBe(12_000);
  });

  it("host semaphore caps concurrent starts at K=2", async () => {
    let concurrentStarts = 0;
    let maxConcurrent = 0;
    daemon.options.healthOnStart = "starting";

    const boundedDriver = dockerBotContainerDriver(
      {
        socketPath: daemon.socketPath,
        volumeRoot: volumesRoot,
        network: "myrmidon-bots",
        allowlist: ["myrmidon-hermes:*"],
        mountSources: [],
        devbuild: { host: null, user: "", base: "" },
      },
      {
        maxConcurrentStarts: 2,
        healthPollIntervalMs: 0,
        startHealthTimeoutMs: 10_000,
        sleep: async () => {
          concurrentStarts++;
          maxConcurrent = Math.max(maxConcurrent, concurrentStarts);
          for (const c of daemon.containers.values()) {
            c.health = "healthy";
          }
          await new Promise((r) => setTimeout(r, 10));
          concurrentStarts--;
        },
      },
    );

    for (const key of ["agent-a", "agent-b", "agent-c"]) {
      await createBot(boundedDriver, key);
    }

    await Promise.all([
      boundedDriver.start("agent-a"),
      boundedDriver.start("agent-b"),
      boundedDriver.start("agent-c"),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2);
  });

  it("host semaphore default K=2 when maxConcurrentStarts is not specified", async () => {
    let concurrentStarts = 0;
    let maxConcurrent = 0;
    daemon.options.healthOnStart = "starting";

    const boundedDriver = dockerBotContainerDriver(
      {
        socketPath: daemon.socketPath,
        volumeRoot: volumesRoot,
        network: "myrmidon-bots",
        allowlist: ["myrmidon-hermes:*"],
        mountSources: [],
        devbuild: { host: null, user: "", base: "" },
      },
      {
        healthPollIntervalMs: 0,
        startHealthTimeoutMs: 10_000,
        sleep: async () => {
          concurrentStarts++;
          maxConcurrent = Math.max(maxConcurrent, concurrentStarts);
          for (const c of daemon.containers.values()) {
            c.health = "healthy";
          }
          await new Promise((r) => setTimeout(r, 10));
          concurrentStarts--;
        },
      },
    );

    for (const key of ["agent-a", "agent-b", "agent-c"]) {
      await createBot(boundedDriver, key);
    }

    await Promise.all([
      boundedDriver.start("agent-a"),
      boundedDriver.start("agent-b"),
      boundedDriver.start("agent-c"),
    ]);

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(maxConcurrent).toBe(2);
  });
});
