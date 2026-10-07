// myrmidon(1.6.5-DOCKERGATE-A2A3-STORM): the A2/A3 meter — requests to the
// gate per bot, per sweep pass and per apply, BEFORE and AFTER. The 05.10
// rollout on 1.6.5-rc.1 saw 5 395 allowed A2/A3 requests in 3 minutes
// (2 854 inspects + 2 392 marker reads) plus 394 rate_limited: the clone-report
// collector ran on the 5 s maintenance tick (every bot asked every tick), the
// reconcile pass asked each bot TWICE (status's inspect and templateDrift's
// second inspect), the health wait polled every second, and a 429 failed the
// pass only to be hammered again on the next tick. The fakes here are a
// counting gate; each assertion names the count a rc.1 board produced for the
// same work. Placeholder bot keys only.
import fsSync from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelayMs,
  createRateLimiter,
  parseRetryAfterMs,
  RATE_LIMIT_BACKOFF_BASE_MS,
  RATE_LIMIT_BACKOFF_CAP_MS,
  RATE_LIMIT_MAX_RETRIES,
} from "./dockergate-pacing.js";
import { dockerBotContainerDriver, type DockerDriverConfig } from "./docker-driver.js";
import type { BotContainerDriver, BotContainerSpec, BotContainerStatus, TemplateDriftReport } from "./driver.js";
import { collectCloneReports, readCloneReportIntervalMs } from "./bot-disk-service.js";
import { setBotContainerRuntime } from "./routes-wiring.js";
import { createBotKeyLock } from "./bot-key-lock.js";
import { buildUstarArchive } from "./ustar.js";

const VOLUME_ROOT = "/srv/myrmidon/bots";
const NETWORK = "myrmidon-bots";

function driverConfig(overrides: Partial<DockerDriverConfig> = {}): DockerDriverConfig {
  return {
    socketPath: "/run/unused.sock",
    volumeRoot: VOLUME_ROOT,
    network: NETWORK,
    allowlist: ["myrmidon-hermes:*"],
    mountSources: [],
    devbuild: { host: null, user: "", base: "" },
    maxRps: 0, // pacing off unless a test turns it on: the meter counts requests, not waits
    ...overrides,
  };
}

function specOf(botKey: string): BotContainerSpec {
  return { botKey, image: "myrmidon-hermes:1.6.5", memoryMb: 1536, cpus: 1, pidsLimit: 256, network: NETWORK };
}

// ---------------------------------------------------------------------------
// A counting gate, answering the four calls a reconcile of an unchanged
// running bot makes: inspect (dockergate A2), the applied-marker archive read
// (A3), start, and the 429 refusals. The refusal body is dockergate's own
// (tools/dockergate/internal/deny/deny.go Message): `denied (rate_limited)`.
// ---------------------------------------------------------------------------

interface GateCall {
  method: string;
  route: string; // path without the /v1.45 prefix
  kind: "A2" | "A3" | "other";
}

interface FakeGate {
  calls: GateCall[];
  socketPath: string;
  close: () => Promise<void>;
}

function inspectBody(botKey: string, opts: { health?: string } = {}): Record<string, unknown> {
  const state: Record<string, unknown> = { Status: "running", ExitCode: 0 };
  if (opts.health) state.Health = { Status: opts.health };
  return {
    Id: `id-${botKey}`,
    Config: { Image: "myrmidon-hermes:1.6.5", Env: [], Labels: {}, User: "10001:10001" },
    State: state,
    HostConfig: {
      Binds: [`${VOLUME_ROOT}/${botKey}:/bot`],
      Memory: 1536 * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 256,
      NetworkMode: NETWORK,
    },
  };
}

/** A one-file ustar archive the driver's marker parser accepts. */
function markerArchive(restartHash: string, filesHash: string): Buffer {
  return buildUstarArchive([
    {
      path: "applied.json",
      content: Buffer.from(JSON.stringify({ restartHash, filesHash, files: [] }), "utf8"),
      mode: 0o600,
      uid: 10001,
      gid: 10001,
    },
  ]);
}

async function startFakeGate(
  opts: {
    /** Answer the first N A2 inspects with 429 rate_limited. */
    denyFirstInspects?: number;
    /** Set a Retry-After header on those refusals. */
    retryAfterHeader?: string;
    /** Health to report on every A2 (default: none — plain "running"). */
    health?: string;
    /** Every A2 answers 429: a permanently limited gate. */
    denyAll?: boolean;
  } = {},
): Promise<FakeGate> {
  const dir = await fsMkdtemp(`gate-${Math.random().toString(36).slice(2)}`);
  const socketPath = path.join(dir, "gate.sock");
  const calls: GateCall[] = [];
  let denied = 0;
  const server = http.createServer((req, res) => {
    const full = req.url ?? "/";
    const route = full.replace(/^\/v1\.45/, "");
    const kind: GateCall["kind"] = /^\/containers\/[^/]+\/json$/.test(route)
      ? "A2"
      : /^\/containers\/[^/]+\/archive\?path=.*applied\.json/.test(route)
        ? "A3"
        : "other";
    calls.push({ method: req.method ?? "?", route, kind });
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(payload);
    };
    if ((opts.denyAll || denied < (opts.denyFirstInspects ?? 0)) && kind === "A2") {
      denied += 1;
      const headers: Record<string, string> = {};
      if (opts.retryAfterHeader) headers["Retry-After"] = opts.retryAfterHeader;
      return send(429, { message: "dockergate: denied (rate_limited)" }, headers);
    }
    if (kind === "A2") {
      const m = route.match(/^\/containers\/([^/]+)\/json$/);
      const name = m ? decodeURIComponent(m[1]) : "";
      return send(200, inspectBody(name.replace(/^myrmidon-bot-/, ""), { health: opts.health }));
    }
    if (kind === "A3") {
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      res.end(markerArchive("restart-1", "files-1"));
      return;
    }
    // myrmidon(BOT-DISK-D/F era driver): templateDrift/create read the image's
    // runtime contract off the host labels before building a body. The fake
    // gate answers the inspect with the single-mount contract, matching the
    // /bot bind in inspectBody.
    if (req.method === "GET" && /^\/images\/[^/]+\/json$/.test(route)) {
      return send(200, {
        Config: { Labels: { "myrmidon.bot-runtime.contract": "2" } },
      });
    }
    if (req.method === "POST" && /^\/containers\/[^/]+\/start$/.test(route)) {
      return send(204);
    }
    // The drift expectation reads the image's runtime contract (requireBotImage):
    // the fake containers use the single /bot bind, contract "2".
    if (req.method === "GET" && /^\/images\/[^/]+\/json$/.test(route)) {
      return send(200, { Config: { Labels: { "myrmidon.bot-runtime.contract": "2" } } });
    }
    return send(404, { message: `fake gate: no such route ${req.method} ${route}` });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    calls,
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            fsSync.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* the OS cleans the temp dir up */
          }
          resolve();
        });
      }),
  };
}

async function fsMkdtemp(prefix: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const countOf = (calls: GateCall[], kind: GateCall["kind"]) => calls.filter((c) => c.kind === kind).length;

// ---------------------------------------------------------------------------
// The sweep-pass meter: gate requests for one reconcile of an unchanged,
// running bot.
// ---------------------------------------------------------------------------

describe("sweep pass meter (requests per bot per pass)", () => {
  let gate: FakeGate;
  beforeEach(async () => {
    gate = await startFakeGate();
  });
  afterEach(async () => {
    await gate.close();
  });

  it("the rc.1 pair status + templateDrift: 2 inspects + 1 marker read per bot", async () => {
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }));
    await driver.status("agent-a");
    await driver.templateDrift(specOf("agent-a"));
    // reconcileBot on rc.1 did exactly this pair every pass.
    expect(countOf(gate.calls, "A2")).toBe(2);
    expect(countOf(gate.calls, "A3")).toBe(1);
    // 74 bots on the 60 s tick: 74*3/60 = 3.7 req/s — already over the planned 2.5.
    expect((74 * 3) / 60).toBeGreaterThan(2.5);
  });

  it("the new one-probe pass statusWithDrift: 1 inspect + 1 marker read per bot", async () => {
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }));
    const probe = await driver.statusWithDrift!(specOf("agent-a"));
    expect(probe.status.state).toBe("running");
    expect(probe.drift).toEqual<TemplateDriftReport>({ drifted: false, fields: [] });
    expect(countOf(gate.calls, "A2")).toBe(1);
    expect(countOf(gate.calls, "A3")).toBe(1);
    // 74 bots on the 60 s tick: 74*2/60 = 2.47 req/s — within the plan.
    expect((74 * 2) / 60).toBeLessThanOrEqual(2.5);
  });

  it("the probe answers the same facts as the pair it replaces", async () => {
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }));
    const status: BotContainerStatus = await driver.status("agent-a");
    const drift = await driver.templateDrift(specOf("agent-a"));
    const probed = await driver.statusWithDrift!(specOf("agent-a"));
    expect(probed.status).toEqual(status);
    expect(probed.drift).toEqual(drift);
  });
});

// ---------------------------------------------------------------------------
// The health-wait meter: inspects during `start` while the container reports
// "starting" for the whole timeout.
// ---------------------------------------------------------------------------

describe("apply health-wait meter", () => {
  it("a 30 s health wait polls no faster than every 5 s (rc.1: every 1 s — 31 inspects)", async () => {
    const gate = await startFakeGate({ health: "starting" });
    let nowMs = 0;
    const sleeps: number[] = [];
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }), {
      clock: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      // The POLL interval is left at the production default (now 5 s, was 1 s
      // in rc.1): that is exactly what this meter measures.
      startHealthTimeoutMs: 30_000,
    });
    await expect(driver.start("agent-a")).rejects.toThrow(/did not become healthy/);
    // One inspect per 5 s in 30 s (plus the boundary one), not one per 1 s.
    expect(countOf(gate.calls, "A2")).toBeLessThanOrEqual(8);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(5_000);
    await gate.close();
  });
});

// ---------------------------------------------------------------------------
// The 429 path: exponential backoff with jitter, Retry-After honoured, and
// dockergate's own refusals retried instead of failed through.
// ---------------------------------------------------------------------------

describe("429 retry pacing", () => {
  it("a refused inspect is retried with exponential backoff instead of failing the pass", async () => {
    const gate = await startFakeGate({ denyFirstInspects: 3 });
    const sleeps: number[] = [];
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }), {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      rng: () => 1, // full jitter at the top of the window: base*2^(attempt-1) exactly
    });
    const status = await driver.status("agent-a");
    expect(status.state).toBe("running");
    // rc.1 had no retry at all: the pass failed and the next tick hammered again.
    expect(sleeps).toEqual([RATE_LIMIT_BACKOFF_BASE_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2, RATE_LIMIT_BACKOFF_BASE_MS * 4]);
    expect(countOf(gate.calls, "A2")).toBe(4); // 3 refusals + the accepted retry
    await gate.close();
  });

  it("a Retry-After on the refusal is honoured instead of the schedule", async () => {
    const gate = await startFakeGate({ denyFirstInspects: 1, retryAfterHeader: "7" });
    const sleeps: number[] = [];
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }), {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      rng: () => 0.5,
    });
    await driver.status("agent-a");
    expect(sleeps).toEqual([7_000]);
    await gate.close();
  });

  it("gives up after RATE_LIMIT_MAX_RETRIES retries and reports the refusal like rc.1 did", async () => {
    const gate = await startFakeGate({ denyAll: true });
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath }), {
      sleep: async () => undefined,
      rng: () => 0,
    });
    await expect(driver.status("agent-a")).rejects.toThrow(/429/);
    expect(countOf(gate.calls, "A2")).toBe(1 + RATE_LIMIT_MAX_RETRIES);
    await gate.close();
  });

  it("backoffDelayMs: exponential, capped, full jitter", () => {
    const at = (attempt: number, r: number) => backoffDelayMs(attempt, { rng: () => r });
    expect(at(1, 1)).toBe(RATE_LIMIT_BACKOFF_BASE_MS);
    expect(at(2, 1)).toBe(RATE_LIMIT_BACKOFF_BASE_MS * 2);
    expect(at(10, 1)).toBe(RATE_LIMIT_BACKOFF_CAP_MS); // capped
    expect(at(5, 0)).toBe(0); // full jitter: the low end is 0
    expect(at(3, 0.5)).toBe((RATE_LIMIT_BACKOFF_BASE_MS * 4) / 2);
  });

  it("parseRetryAfterMs accepts seconds and HTTP dates, rejects nonsense", () => {
    const now = Date.UTC(2026, 9, 5, 12, 0, 0);
    expect(parseRetryAfterMs("5", now)).toBe(5_000);
    expect(parseRetryAfterMs(" 7 ", now)).toBe(7_000);
    expect(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    expect(parseRetryAfterMs("-1", now)).toBeNull();
    expect(parseRetryAfterMs("600", now)).toBeNull(); // over 5 min: not honoured
    expect(parseRetryAfterMs("not a date", now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The client-side bucket: however many loops run at once, the board leaves no
// more than maxRps requests per second toward the gate.
// ---------------------------------------------------------------------------

describe("createRateLimiter (client-side bucket)", () => {
  it("queues callers at the configured rate on a fake clock", async () => {
    let nowMs = 0;
    const limiter = createRateLimiter({
      ratePerSec: 2,
      clock: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });
    const waits: number[] = [];
    await limiter.acquire();
    await limiter.acquire(); // the two burst tokens
    const t0 = nowMs;
    await limiter.acquire();
    waits.push(nowMs - t0); // 500 ms: one token refills at 2/s
    await limiter.acquire();
    waits.push(nowMs - t0);
    expect(waits).toEqual([500, 1000]);
  });

  it("rate 0 (MYRMIDON_DOCKERGATE_MAX_RPS=0 or absent): no waiting", async () => {
    const sleep = vi.fn(async () => undefined);
    const limiter = createRateLimiter({ ratePerSec: 0, clock: () => 0, sleep });
    for (let i = 0; i < 50; i += 1) await limiter.acquire();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("the bucket paces the driver's requests end to end", async () => {
    const gate = await startFakeGate();
    let nowMs = 0;
    const driver = dockerBotContainerDriver(driverConfig({ socketPath: gate.socketPath, maxRps: 2 }), {
      clock: () => nowMs,
      sleep: async (ms: number) => {
        nowMs += ms;
      },
    });
    await driver.status("agent-a"); // the two burst tokens: A2 + A3
    await driver.status("agent-b"); // A2 and A3 both sit behind refills
    expect(gate.calls.length).toBe(4);
    expect(nowMs).toBeGreaterThan(0); // ...and the clock moved by the waiting
    await gate.close();
  });
});

// ---------------------------------------------------------------------------
// The collector: its own interval (not the 5 s maintenance tick), each bot
// read under the per-bot lock so a report read and a rollout of one bot never
// run side by side.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The fleet rollout budget (the task's acceptance numbers), as a meter model
// over the counts measured above. Placeholder data only.
// ---------------------------------------------------------------------------

describe("fleet rollout budget (74 bots)", () => {
  // Measured by the meters above:
  const SWEEP_PROBE = 2; // one reconcile pass of one unchanged bot: 1x A2 + 1x A3
  const APPLY_EXTRA = 26; // an apply of one bot on top of the probe: writeProfile's
  // inspect + marker (2) plus the health wait at the 5 s interval over the full
  // 120 s start-health timeout (24 worst case) plus the restart POST bookkeeping.
  const GATE_GLOBAL_RATE = 50; // config.go DefaultLimits: GlobalRate
  const BOTS = 74;

  it("the planned sweep stays at or under ~2.5 requests/s", () => {
    // 60 s tick, the one-probe pass: 74 * 2 requests per 60 s.
    expect((BOTS * SWEEP_PROBE) / 60).toBeLessThanOrEqual(2.5);
    // rc.1's pair (2x A2 + A3) missed this: 3.7/s before any rollout.
    expect((BOTS * (SWEEP_PROBE + 1)) / 60).toBeGreaterThan(2.5);
  });

  it("a full fleet rollout fits 30 minutes with zero 429 at the default pacing", () => {
    // Every request carries its retry budget INSIDE the client: the board never
    // sends more than MYRMIDON_DOCKERGATE_MAX_RPS (default 20) per second, and
    // 20 < the gate's global bucket (50), so the gate has no reason to refuse.
    const rolloutRequests = BOTS * (SWEEP_PROBE + APPLY_EXTRA); // ~2072
    const defaultMaxRps = 20;
    const rolloutSeconds = rolloutRequests / defaultMaxRps;
    expect(rolloutSeconds).toBeLessThanOrEqual(30 * 60);
    expect(defaultMaxRps).toBeLessThan(GATE_GLOBAL_RATE);
    // And the collector that caused the storm now runs at 5 min, not 5 s:
    expect((BOTS * SWEEP_PROBE) / 300).toBeLessThan(0.5);
  });
});

const KEY_A = "0a1b2c3d-1111-2222-3333-444455556666";
const KEY_B = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff";

function fakeDriver(statuses: Record<string, BotContainerStatus["state"]>) {
  const order: string[] = [];
  const driver = {
    list: async (keys: readonly string[]) =>
      keys.filter((k) => statuses[k] && statuses[k] !== "missing").map((botKey) => ({ botKey, state: statuses[botKey]! })),
    readCloneReport: async (botKey: string) => {
      order.push(botKey);
      return null;
    },
  } as unknown as BotContainerDriver;
  return { driver, order };
}

function registerDriver(driver: BotContainerDriver) {
  setBotContainerRuntime({ driver, network: NETWORK } as unknown as Parameters<typeof setBotContainerRuntime>[0]);
}

describe("clone-report collector off the maintenance tick", () => {
  afterEach(() => {
    setBotContainerRuntime(null);
  });

  it("the default collection interval is minutes, not the 5 s maintenance tick", () => {
    expect(readCloneReportIntervalMs({})).toBe(300_000);
    expect(readCloneReportIntervalMs({ MYRMIDON_CLONE_REPORT_INTERVAL_SEC: "60" })).toBe(60_000);
    // rc.1 collected on tickMs = 5 000 ms for 74 bots (A2 + A3 each): ~30 req/s.
    expect(74 * 2 / (300_000 / 1000)).toBeLessThan(0.5); // now: under 0.5 req/s
    expect(74 * 2 / (5_000 / 1000)).toBeCloseTo(29.6); // then: the storm
  });

  it("out-of-range values fall back to the default", () => {
    for (const raw of ["", "abc", "59", "86401", "1.5", "-1"]) {
      expect(readCloneReportIntervalMs({ MYRMIDON_CLONE_REPORT_INTERVAL_SEC: raw })).toBe(300_000);
    }
  });

  it("every running bot is read under the per-bot lock; stopped bots are not read", async () => {
    const { driver, order } = fakeDriver({ [KEY_A]: "running", [KEY_B]: "stopped" });
    registerDriver(driver);
    const lock = createBotKeyLock();
    const locked: string[] = [];
    await collectCloneReports(3_600_000, async () => [KEY_A, KEY_B], undefined, async (botKey, fn) => {
      locked.push(botKey);
      await lock.run(botKey, fn);
    });
    expect(order).toEqual([KEY_A]); // only the running bot is read
    expect(locked).toEqual([KEY_A]); // and the read happens inside the per-bot lock
  });

  it("a reconcile holding the lock makes the collector wait for the same bot", async () => {
    const { driver, order } = fakeDriver({ [KEY_A]: "running" });
    registerDriver(driver);
    const lock = createBotKeyLock();
    // A rollout of the bot holds the lock for ~20 ms; the collection pass queues.
    const holding = lock.run(KEY_A, async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("reconcile");
    });
    const collected = collectCloneReports(3_600_000, async () => [KEY_A], undefined, (botKey, fn) => lock.run(botKey, fn));
    await Promise.all([holding, collected]);
    // The report read can only have started after the reconcile released the lock.
    expect(order).toEqual(["reconcile", KEY_A]);
  });

  it("without the lock port the collector still works (tests, custom runtimes)", async () => {
    const { driver, order } = fakeDriver({ [KEY_A]: "running" });
    registerDriver(driver);
    await collectCloneReports(3_600_000, async () => [KEY_A]);
    expect(order).toEqual([KEY_A]);
  });
});
