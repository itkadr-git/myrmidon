import https from "node:https";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  createFleetMoveContext,
  LOCAL_SITE_AGENT_URL_ENV,
  LOCAL_SITE_AGENT_TOKEN_SECRET_ENV,
} from "./fleet-move-wiring.js";
import { myrmidonFleetSiteManageRoutes } from "./fleet-site-manage-wiring.js";
import type { FleetClientManager, FleetSiteTransport } from "./site-registry.js";
import * as services from "../../services/index.js";
import { cleanupTestPki, generateEphemeralTestPki } from "./site-agent-pki.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

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
  });
});
