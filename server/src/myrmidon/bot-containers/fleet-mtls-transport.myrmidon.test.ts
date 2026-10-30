import https from "node:https";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Db } from "@myrmidon/db";
import { myrmidonFleetSites } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import {
  createFleetMoveContext,
  LOCAL_SITE_AGENT_URL_ENV,
  LOCAL_SITE_AGENT_TOKEN_SECRET_ENV,
} from "./fleet-move-wiring.js";
import { myrmidonFleetSiteManageRoutes } from "./fleet-site-manage-wiring.js";
import { fleetdBotContainerDriver } from "./fleetd-driver.js";
import type { FleetClientManager, FleetSiteTransport } from "./site-registry.js";
import * as services from "../../services/index.js";
import { cleanupTestPki, generateEphemeralTestPki } from "./site-agent-pki.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_KEY = "44444444-4444-4444-8444-444444444444";

describe("fleet mTLS transport wiring", () => {
  let pki: ReturnType<typeof generateEphemeralTestPki>;

  beforeEach(() => {
    pki = generateEphemeralTestPki();
  });

  afterEach(() => {
    cleanupTestPki(pki);
    vi.restoreAllMocks();
  });

  describe("createFleetMoveContext resolveSiteHost", () => {
    it("resolves local site using environment variables without requiring mTLS", async () => {
      const origUrl = process.env[LOCAL_SITE_AGENT_URL_ENV];
      const origSecret = process.env[LOCAL_SITE_AGENT_TOKEN_SECRET_ENV];
      process.env[LOCAL_SITE_AGENT_URL_ENV] = "http://127.0.0.1:8642";
      process.env[LOCAL_SITE_AGENT_TOKEN_SECRET_ENV] = "local-token-sec";

      vi.spyOn(services, "secretService").mockReturnValue({
        getByName: vi.fn(async () => ({ id: "sec-1" })),
        resolveSecretValue: vi.fn(async () => "resolved-local-token"),
      } as any);

      try {
        const db = { marker: "db" } as unknown as Db;
        const ctx = createFleetMoveContext(db);
        const client = await ctx.siteAgentClient("local", COMPANY_ID);
        expect(client).toBeDefined();
      } finally {
        if (origUrl !== undefined) process.env[LOCAL_SITE_AGENT_URL_ENV] = origUrl;
        else delete process.env[LOCAL_SITE_AGENT_URL_ENV];
        if (origSecret !== undefined) process.env[LOCAL_SITE_AGENT_TOKEN_SECRET_ENV] = origSecret;
        else delete process.env[LOCAL_SITE_AGENT_TOKEN_SECRET_ENV];
      }
    });

    it("rejects remote site when clientManager is missing and site is not registered", async () => {
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as unknown as Db;

      const ctx = createFleetMoveContext(db);
      await expect(ctx.siteAgentClient("remote-vm1", COMPANY_ID)).rejects.toThrow(
        'site "remote-vm1" is unknown: it is neither in MYRMIDON_FLEET_HOSTS nor in the site registry',
      );
    });

    it("rejects remote site when transport has incomplete mTLS credentials", async () => {
      const db = { marker: "db" } as unknown as Db;
      const incompleteTransport: FleetSiteTransport = {
        baseUrl: "https://remote-vm1.test:9443",
        token: "tok",
        mtls: false,
      };
      const transports = new Map<string, FleetSiteTransport>();
      transports.set(`${COMPANY_ID}:remote-vm1`, incompleteTransport);

      const manager: FleetClientManager = {
        getClients: () => new Map(),
        getTransports: () => transports,
        refresh: async () => transports as any,
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const ctx = createFleetMoveContext(db, manager);
      await expect(ctx.siteAgentClient("remote-vm1", COMPANY_ID)).rejects.toThrow(
        'site "remote-vm1" has no valid mTLS client certificate, key, or CA',
      );
    });

    it("returns mTLS client when transport has full mTLS credentials", async () => {
      const db = { marker: "db" } as unknown as Db;
      const agent = new https.Agent({
        cert: pki.clientCert,
        key: pki.clientKey,
        ca: pki.caCert,
      });
      const validTransport: FleetSiteTransport = {
        baseUrl: "https://remote-vm1.test:9443",
        token: "tok",
        agent,
        caCert: pki.caCert,
        clientCert: pki.clientCert,
        clientKey: pki.clientKey,
        mtls: true,
      };
      const transports = new Map<string, FleetSiteTransport>();
      transports.set(`${COMPANY_ID}:remote-vm1`, validTransport);

      const manager: FleetClientManager = {
        getClients: () => new Map(),
        getTransports: () => transports,
        refresh: async () => transports as any,
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const ctx = createFleetMoveContext(db, manager);
      const client = await ctx.siteAgentClient("remote-vm1", COMPANY_ID);
      expect(client).toBeDefined();
    });
  });

  describe("myrmidonFleetSiteManageRoutes mTLS verification", () => {
    function createMockDb(host: string | null = "remote-vm1") {
      const selectMock = vi.fn((_fields?: unknown) => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn((_condition: unknown) => ({
            limit: vi.fn(async (_n: number) => {
              if (table === myrmidonFleetSites) {
                return [
                  {
                    id: "site-1",
                    companyId: COMPANY_ID,
                    name: "remote-vm1",
                    status: "active",
                    health: { state: "healthy" },
                    clientCertNotAfter: new Date(Date.now() + 86400000),
                  },
                ];
              }
              return [
                {
                  companyId: COMPANY_ID,
                  adapterConfig: host ? { container: { host } } : {},
                },
              ];
            }),
          })),
        })),
      }));
      return { select: selectMock } as unknown as Db;
    }

    function createTestApp(db: Db, manager: FleetClientManager) {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "board", source: "local_implicit" };
        next();
      });
      app.use(express.json());
      app.use("/", myrmidonFleetSiteManageRoutes(db, manager));
      app.use(errorHandler);
      return app;
    }

    it("creates router with clientManager and verifies mTLS routing structure", async () => {
      const db = { marker: "db" } as unknown as Db;
      const manager: FleetClientManager = {
        getClients: () => new Map(),
        getTransports: () => new Map(),
        refresh: async () => new Map(),
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const router = myrmidonFleetSiteManageRoutes(db, manager);
      expect(router).toBeDefined();
    });

    it("executes restart and stop via real HTTPS mutual TLS", async () => {
      let restartCalled = false;
      let stopCalled = false;
      const server = https.createServer(
        {
          cert: pki.serverCert,
          key: pki.serverKey,
          ca: pki.caCert,
          requestCert: true,
          rejectUnauthorized: true,
        },
        (req, res) => {
          const cert = (req.socket as any).getPeerCertificate();
          if (!cert?.subject?.CN) {
            res.writeHead(403);
            res.end("Certificate required");
            return;
          }
          if (req.method === "POST" && req.url === "/v1/bots/work-bot/restart") {
            restartCalled = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else if (req.method === "POST" && req.url === "/v1/bots/work-bot/stop") {
            stopCalled = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(404);
            res.end("not found");
          }
        },
      );

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as { port: number };
      const baseUrl = `https://127.0.0.1:${address.port}`;

      try {
        const httpsAgent = new https.Agent({
          cert: pki.clientCert,
          key: pki.clientKey,
          ca: pki.caCert,
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
        });

        const driver = fleetdBotContainerDriver({
          baseUrl,
          httpsAgent,
          caCert: pki.caCert,
          clientCert: pki.clientCert,
          clientKey: pki.clientKey,
        });

        await driver.restart("work-bot");
        expect(restartCalled).toBe(true);

        await driver.stop("work-bot");
        expect(stopCalled).toBe(true);

        const unauthAgent = new https.Agent({
          ca: pki.caCert,
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
        });
        const unauthDriver = fleetdBotContainerDriver({
          baseUrl,
          httpsAgent: unauthAgent,
          caCert: pki.caCert,
        });
        await expect(unauthDriver.restart("work-bot")).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("executes restart and stop via route when mTLS transport and driver are valid", async () => {
      const db = createMockDb("remote-vm1");
      const restartSpy = vi.fn(async () => {});
      const stopSpy = vi.fn(async () => {});

      const agent = new https.Agent({
        cert: pki.clientCert,
        key: pki.clientKey,
        ca: pki.caCert,
      });
      const validTransport: FleetSiteTransport = {
        baseUrl: "https://remote-vm1.test:9443",
        token: "tok",
        agent,
        caCert: pki.caCert,
        clientCert: pki.clientCert,
        clientKey: pki.clientKey,
        mtls: true,
      };

      const transports = new Map<string, FleetSiteTransport>();
      transports.set(`${COMPANY_ID}:remote-vm1`, validTransport);

      const clients = new Map<string, any>();
      clients.set(`${COMPANY_ID}:remote-vm1`, {
        restart: restartSpy,
        stop: stopSpy,
      });

      const manager: FleetClientManager = {
        getClients: () => clients,
        getTransports: () => transports,
        refresh: async () => transports as any,
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const app = createTestApp(db, manager);

      const restartRes = await request(app).post(`/myrmidon/fleet/bots/${BOT_KEY}/restart`);
      expect(restartRes.status).toBe(200);
      expect(restartRes.body).toMatchObject({
        ok: true,
        botKey: BOT_KEY,
        site: "remote-vm1",
        action: "restart",
      });
      expect(restartSpy).toHaveBeenCalledWith(BOT_KEY);

      const stopRes = await request(app).post(`/myrmidon/fleet/bots/${BOT_KEY}/stop`);
      expect(stopRes.status).toBe(200);
      expect(stopRes.body).toMatchObject({
        ok: true,
        botKey: BOT_KEY,
        site: "remote-vm1",
        action: "stop",
      });
      expect(stopSpy).toHaveBeenCalledWith(BOT_KEY);
    });

    it("rejects restart and stop via route with 502 Bad Gateway when mTLS credentials are missing or invalid", async () => {
      const db = createMockDb("remote-vm1");
      const incompleteTransport: FleetSiteTransport = {
        baseUrl: "https://remote-vm1.test:9443",
        token: "tok",
        mtls: false,
      };

      const transports = new Map<string, FleetSiteTransport>();
      transports.set(`${COMPANY_ID}:remote-vm1`, incompleteTransport);

      const manager: FleetClientManager = {
        getClients: () => new Map(),
        getTransports: () => transports,
        refresh: async () => transports as any,
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const app = createTestApp(db, manager);

      const restartRes = await request(app).post(`/myrmidon/fleet/bots/${BOT_KEY}/restart`);
      expect(restartRes.status).toBe(502);
      expect(restartRes.body.error).toContain(
        'Site "remote-vm1" could not restart bot "' + BOT_KEY + '": site "remote-vm1" has no valid mTLS client certificate, key, or CA',
      );

      const stopRes = await request(app).post(`/myrmidon/fleet/bots/${BOT_KEY}/stop`);
      expect(stopRes.status).toBe(502);
      expect(stopRes.body.error).toContain(
        'Site "remote-vm1" could not stop bot "' + BOT_KEY + '": site "remote-vm1" has no valid mTLS client certificate, key, or CA',
      );
    });

    it("rejects logs via route with 502 Bad Gateway when mTLS credentials are missing or invalid", async () => {
      const db = createMockDb("remote-vm1");
      const incompleteTransport: FleetSiteTransport = {
        baseUrl: "https://remote-vm1.test:9443",
        token: "tok",
        mtls: false,
      };

      const transports = new Map<string, FleetSiteTransport>();
      transports.set(`${COMPANY_ID}:remote-vm1`, incompleteTransport);

      const manager: FleetClientManager = {
        getClients: () => new Map(),
        getTransports: () => transports,
        refresh: async () => transports as any,
        getVersion: () => 1,
        ensureFresh: vi.fn(async () => {}),
        close: () => {},
      };

      const app = createTestApp(db, manager);

      const logsRes = await request(app).get(`/myrmidon/fleet/bots/${BOT_KEY}/logs?tail=50`);
      expect(logsRes.status).toBe(502);
      expect(logsRes.body.error).toContain(
        'Site "remote-vm1" logs failed: site "remote-vm1" has no valid mTLS client certificate, key, or CA',
      );
    });
  });
});
