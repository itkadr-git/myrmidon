// myrmidon(OPE-12032): bot management on a remote site across the api/worker split.
//
// The board of the live installation runs `processes.mode = split`: api children
// serve HTTP and the worker owns everything periodic. The site mTLS client
// manager is built by `startBotContainers`, which only the worker runs, so an
// api child had no manager (`getActiveFleetClientManager()` is null there) and
// answered restart/stop/logs of a bot on a registered, healthy site with
// "site has no active mTLS client transport". The fleet control routes now ride
// the singleton-proxy allowlist: the api child forwards them to the worker, which
// holds the manager and reaches the site's fleetd through the mTLS transport.
//
// Two real HTTP servers stand for the two processes (api child -> worker), a real
// mutual-TLS server stands for the site's fleetd (logs), and the driver of the
// site is a mock with spies (restart/stop). Pins:
//   * restart / stop / logs sent to the api child reach the worker's driver and
//     fleetd, with the caller's query and credentials intact;
//   * with forwarding off (or no manager at all) the answer is the old, clear
//     502 naming the site, and nothing is sent to the site.

import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { myrmidonFleetSites } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { singletonProxyMiddleware } from "../singleton-proxy/index.js";
import { myrmidonFleetSiteManageRoutes } from "./fleet-site-manage-wiring.js";
import { cleanupTestPki, generateEphemeralTestPki } from "./site-agent-pki.js";
import { getActiveFleetClientManager, type FleetClientManager, type FleetSiteTransport } from "./site-registry.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_KEY = "44444444-4444-4444-8444-444444444444";
const SITE = "myr-vm1";

function createMockDb(): Db {
  const select = vi.fn((_fields?: unknown) => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn((_condition: unknown) => ({
        limit: vi.fn(async (_n: number) => {
          if (table === myrmidonFleetSites) {
            return [
              {
                id: "site-1",
                companyId: COMPANY_ID,
                name: SITE,
                status: "active",
                health: { state: "healthy" },
                clientCertNotAfter: new Date(Date.now() + 86_400_000),
              },
            ];
          }
          return [{ companyId: COMPANY_ID, adapterConfig: { container: { host: SITE } } }];
        }),
      })),
    })),
  }));
  return { select } as unknown as Db;
}

function boardActor(app: express.Express): void {
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit" };
    next();
  });
}

async function listen(server: http.Server | https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: http.Server | https.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("fleet bot management across the api/worker split (OPE-12032)", () => {
  let pki: ReturnType<typeof generateEphemeralTestPki>;
  let fleetd: https.Server;
  let fleetdSeen: Array<{ url: string; clientCn: string | undefined }>;
  let worker: http.Server;
  let apiChild: http.Server;
  let apiPort = 0;
  let workerPort = 0;

  let forwarding = true;
  let workerManager: FleetClientManager | null = null;
  const restartSpy = vi.fn(async (_botKey: string) => {});
  const stopSpy = vi.fn(async (_botKey: string) => {});

  function buildManager(fleetdPort: number): FleetClientManager {
    const agent = new https.Agent({
      cert: pki.clientCert,
      key: pki.clientKey,
      ca: pki.caCert,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    });
    const transport: FleetSiteTransport = {
      baseUrl: `https://127.0.0.1:${fleetdPort}`,
      token: "tok",
      agent,
      caCert: pki.caCert,
      clientCert: pki.clientCert,
      clientKey: pki.clientKey,
      mtls: true,
    };
    const transports = new Map<string, FleetSiteTransport>([[`${COMPANY_ID}/${SITE}`, transport]]);
    const clients = new Map<string, any>([[`${COMPANY_ID}/${SITE}`, { restart: restartSpy, stop: stopSpy }]]);
    return {
      getClients: () => clients,
      getTransports: () => transports,
      refresh: async () => transports as any,
      getVersion: () => 1,
      ensureFresh: vi.fn(async () => {}),
      close: () => {},
    };
  }

  beforeAll(async () => {
    pki = generateEphemeralTestPki();

    // The site's fleetd: mutual TLS, a client certificate is required.
    fleetdSeen = [];
    fleetd = https.createServer(
      { cert: pki.serverCert, key: pki.serverKey, ca: pki.caCert, requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        const clientCn = (req.socket as any).getPeerCertificate()?.subject?.CN as string | undefined;
        fleetdSeen.push({ url: `${req.method} ${req.url}`, clientCn });
        if (req.method === "GET" && req.url === `/v1/bots/${BOT_KEY}/logs?tail=100`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ logs: "line one\nline two\n" }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      },
    );
    const fleetdPort = await listen(fleetd);
    workerManager = buildManager(fleetdPort);

    // The worker process: the full board app; its manager is the one startBotContainers built.
    const workerApp = express();
    boardActor(workerApp);
    workerApp.use(express.json());
    workerApp.use("/api", myrmidonFleetSiteManageRoutes(createMockDb(), () => workerManager));
    workerApp.use(errorHandler);
    worker = http.createServer(workerApp);
    workerPort = await listen(worker);

    // An api child: the proxy first, then its own routes. Its manager getter is the real
    // `getActiveFleetClientManager` of index.ts, and nothing in this process ever called
    // `startBotContainers`, so it is null here exactly as on a live api child.
    expect(getActiveFleetClientManager()).toBeNull();
    const apiApp = express();
    apiApp.use(singletonProxyMiddleware({ target: { host: "127.0.0.1", port: workerPort }, enabled: () => forwarding }));
    boardActor(apiApp);
    apiApp.use(express.json());
    apiApp.use("/api", myrmidonFleetSiteManageRoutes(createMockDb(), getActiveFleetClientManager));
    apiApp.use(errorHandler);
    apiChild = http.createServer(apiApp);
    apiPort = await listen(apiChild);
  });

  afterAll(async () => {
    await Promise.all([close(apiChild), close(worker), close(fleetd)]);
    cleanupTestPki(pki);
  });

  beforeEach(() => {
    forwarding = true;
    fleetdSeen.length = 0;
    restartSpy.mockClear();
    stopSpy.mockClear();
  });

  const apiUrl = (path: string) => `http://127.0.0.1:${apiPort}${path}`;
  const workerUrl = (path: string) => `http://127.0.0.1:${workerPort}${path}`;

  it("restart sent to the api child reaches the site driver through the worker's mTLS transport", async () => {
    const res = await fetch(apiUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/restart?companyId=${COMPANY_ID}`), { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, botKey: BOT_KEY, site: SITE, action: "restart" });
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(restartSpy).toHaveBeenCalledWith(BOT_KEY);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(workerManager!.ensureFresh).toHaveBeenCalled();
  });

  it("stop sent to the api child reaches the site driver through the worker's mTLS transport", async () => {
    const res = await fetch(apiUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/stop?companyId=${COMPANY_ID}`), { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, botKey: BOT_KEY, site: SITE, action: "stop" });
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledWith(BOT_KEY);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it("logs asked of the api child are read from the site's fleetd over mutual TLS", async () => {
    const res = await fetch(apiUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/logs?companyId=${COMPANY_ID}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ botKey: BOT_KEY, site: SITE, logs: "line one\nline two" });
    expect(fleetdSeen).toEqual([{ url: `GET /v1/bots/${BOT_KEY}/logs?tail=100`, clientCn: expect.any(String) }]);
    expect(fleetdSeen[0]!.clientCn).toBeTruthy();
  });

  it("an api child that serves the route itself has no manager: the old clear 502, nothing sent to the site", async () => {
    forwarding = false; // `processes.singletonProxy` off: the api child answers on its own
    for (const action of ["restart", "stop"] as const) {
      const res = await fetch(apiUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/${action}?companyId=${COMPANY_ID}`), { method: "POST" });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe(
        `Site "${SITE}" could not ${action} bot "${BOT_KEY}": site "${SITE}" has no active mTLS client transport`,
      );
    }
    const logs = await fetch(apiUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/logs?companyId=${COMPANY_ID}`));
    expect(logs.status).toBe(502);
    expect((await logs.json()).error).toContain(`site "${SITE}" has no active mTLS client transport`);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(fleetdSeen).toEqual([]);
  });

  it("a worker without a manager (bot containers off) keeps the same clear 502", async () => {
    const saved = workerManager;
    workerManager = null;
    try {
      const res = await fetch(workerUrl(`/api/myrmidon/fleet/bots/${BOT_KEY}/restart?companyId=${COMPANY_ID}`), { method: "POST" });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe(
        `Site "${SITE}" could not restart bot "${BOT_KEY}": site "${SITE}" has no active mTLS client transport`,
      );
      expect(restartSpy).not.toHaveBeenCalled();
    } finally {
      workerManager = saved;
    }
  });
});
