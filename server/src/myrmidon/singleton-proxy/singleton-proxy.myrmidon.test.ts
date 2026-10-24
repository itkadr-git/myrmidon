// myrmidon(1.6.6 PROCS-1.5 / OPE-5412, design OPE-5394 §7.1): the single-route
// proxy of an api process. Pins:
//   * the allowlist: the four route groups forward, everything else is local;
//   * transparent authorization: the worker sees the caller's own headers,
//     method, path, query and body, and its status/headers/body come back as is;
//   * the setting `singletonProxy` off, or a non-allowlisted route, serves
//     locally (next());
//   * a dead worker is 503 + Retry-After, counted as `unavailable`, never a
//     local answer;
//   * only the `api` role gets proxy options — the default single process
//     (`all`) and the worker mount nothing (no behaviour change);

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSingletonProxySample,
  resetSingletonProxyCounters,
  singletonProxyMiddleware,
  singletonProxyOptionsFor,
  singletonRouteGroup,
  resolveSingletonProxyTarget,
} from "./index.js";

describe("singletonRouteGroup", () => {
  it("forwards the four groups", () => {
    expect(singletonRouteGroup("GET", "/companies/c1/attention")).toBe("attention");
    expect(singletonRouteGroup("GET", "/plugins")).toBe("plugins");
    expect(singletonRouteGroup("POST", "/plugins/p1/jobs/j1/trigger")).toBe("plugins");
    expect(singletonRouteGroup("DELETE", "/plugins/p1")).toBe("plugins");
    expect(singletonRouteGroup("POST", "/myrmidon/agents/a1/bot-container/apply")).toBe("bot_container");
    expect(singletonRouteGroup("GET", "/myrmidon/agents/a1/bot-container/status")).toBe("bot_container");
    expect(singletonRouteGroup("POST", "/projects/p/workspaces/w/runtime-services/start")).toBe("workspace_runtime");
    expect(singletonRouteGroup("POST", "/execution-workspaces/e/runtime-commands/run")).toBe("workspace_runtime");
  });

  it("leaves every other route, method and look-alike path to the api process", () => {
    expect(singletonRouteGroup("POST", "/companies/c1/attention")).toBeNull();
    expect(singletonRouteGroup("GET", "/companies/c1/attention/extra")).toBeNull();
    expect(singletonRouteGroup("GET", "/pluginsx")).toBeNull();
    expect(singletonRouteGroup("GET", "/health")).toBeNull();
    expect(singletonRouteGroup("GET", "/companies/c1/issues")).toBeNull();
    expect(singletonRouteGroup("GET", "/myrmidon/agents/a1/bot-containers")).toBeNull();
    expect(singletonRouteGroup("GET", "/projects/p/workspaces/w/runtime-services/start")).toBeNull();
  });
});

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

describe("singletonProxyMiddleware", () => {
  let worker: http.Server;
  let workerPort = 0;
  let seen: Seen | null = null;
  let apiServer: http.Server | null = null;
  let enabled = true;

  beforeEach(async () => {
    resetSingletonProxyCounters();
    seen = null;
    enabled = true;
    worker = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        if (req.url?.includes("/plugins/teapot")) {
          res.writeHead(418, { "x-worker": "yes", "content-type": "application/json" });
          res.end(JSON.stringify({ from: "worker" }));
          return;
        }
        res.writeHead(200, { "x-worker": "yes", "content-type": "application/json" });
        res.end(JSON.stringify({ from: "worker", echoed: seen.body }));
      });
    });
    await new Promise<void>((r) => worker.listen(0, "127.0.0.1", r));
    workerPort = (worker.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => worker.close(() => r()));
    if (apiServer) await new Promise<void>((r) => apiServer!.close(() => r()));
    apiServer = null;
  });

  async function startApi(port = workerPort): Promise<number> {
    const app = express();
    app.use(singletonProxyMiddleware({ target: { host: "127.0.0.1", port }, enabled: () => enabled }));
    app.use(express.json());
    app.all("/api/*splat", (_req, res) => res.json({ from: "api" }));
    apiServer = http.createServer(app);
    await new Promise<void>((r) => apiServer!.listen(0, "127.0.0.1", r));
    return (apiServer.address() as AddressInfo).port;
  }

  const count = (route: string, outcome: string) =>
    readSingletonProxySample().find((row) => row.route === route && row.outcome === outcome)?.count;

  it("forwards an allowlisted route with the caller's credentials, query and body, and returns the worker's answer", async () => {
    const port = await startApi();
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/p1/jobs?x=1`, {
      method: "POST",
      headers: { authorization: "Bearer caller-token", cookie: "sid=abc", "content-type": "application/json", origin: "https://board.example" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-worker")).toBe("yes");
    expect(await res.json()).toEqual({ from: "worker", echoed: '{"hello":"world"}' });
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/api/plugins/p1/jobs?x=1");
    expect(seen?.headers.authorization).toBe("Bearer caller-token");
    expect(seen?.headers.cookie).toBe("sid=abc");
    expect(seen?.headers.origin).toBe("https://board.example");
    expect(seen?.headers["x-forwarded-for"]).toBeTruthy();
    expect(count("plugins", "proxied")).toBe(1);
  });

  it("passes the worker's non-200 status through", async () => {
    const port = await startApi();
    const res = await fetch(`http://127.0.0.1:${port}/api/plugins/teapot`);
    expect(res.status).toBe(418);
    expect(count("plugins", "proxied")).toBe(1);
  });

  it("serves routes outside the allowlist itself", async () => {
    const port = await startApi();
    const res = await fetch(`http://127.0.0.1:${port}/api/companies/c1/issues`);
    expect(await res.json()).toEqual({ from: "api" });
    expect(seen).toBeNull();
    expect(readSingletonProxySample().every((row) => row.count === 0)).toBe(true);
  });

  it("serves allowlisted routes itself while the setting is off", async () => {
    enabled = false;
    const port = await startApi();
    const res = await fetch(`http://127.0.0.1:${port}/api/companies/c1/attention`);
    expect(await res.json()).toEqual({ from: "api" });
    expect(seen).toBeNull();
    expect(count("attention", "proxied")).toBe(0);
  });

  it("answers 503 with Retry-After when the worker is down, and counts it", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const port = await startApi(deadPort);
    const res = await fetch(`http://127.0.0.1:${port}/api/companies/c1/attention`);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect((await res.json()).error).toBe("worker_unavailable");
    expect(count("attention", "unavailable")).toBe(1);
    expect(count("attention", "proxied")).toBe(0);
  });
});

describe("singletonProxyOptionsFor", () => {
  const deps = (stored: unknown, env: NodeJS.ProcessEnv = {}) => ({
    readProcessesSetting: async () => stored,
    env,
  });

  it("is null for the single process and the worker — no behaviour change by default", () => {
    expect(singletonProxyOptionsFor("all", deps(undefined))).toBeNull();
    expect(singletonProxyOptionsFor("worker", deps(undefined))).toBeNull();
  });

  it("is on by default for an api process and follows the saved setting, cached for a moment", async () => {
    let now = 1_000;
    let stored: unknown = undefined;
    let reads = 0;
    const options = singletonProxyOptionsFor("api", {
      readProcessesSetting: async () => {
        reads += 1;
        return stored;
      },
      env: {},
      now: () => now,
    })!;
    expect(await options.enabled()).toBe(true);
    await options.enabled();
    expect(reads).toBe(1);
    stored = { singletonProxy: false };
    now += 10_000;
    expect(await options.enabled()).toBe(false);
  });

  it("dials the loopback worker listener, or the launch map's worker address", () => {
    expect(resolveSingletonProxyTarget({})).toEqual({ host: "127.0.0.1", port: 3101 });
    expect(resolveSingletonProxyTarget({ MYRMIDON_WORKER_HOST: "127.0.0.2", MYRMIDON_WORKER_PORT: "3104" })).toEqual({
      host: "127.0.0.2",
      port: 3104,
    });
    expect(resolveSingletonProxyTarget({ MYRMIDON_WORKER_PORT: "80" }).port).toBe(3101);
  });
});
