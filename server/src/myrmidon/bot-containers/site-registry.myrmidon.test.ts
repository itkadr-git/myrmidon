import { describe, expect, it, vi } from "vitest";
import {
  bumpFleetRegistryVersion,
  createFleetClientManager,
  getFleetRegistryVersion,
  type FleetSite,
  type FleetSiteInsert,
} from "./site-registry.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import type { FleetdDriverConfig } from "./fleetd-driver.js";

function fakeDriver(name: string): BotContainerDriver {
  return {
    async status(botKey: string): Promise<BotContainerStatus> {
      return { botKey, state: "running" };
    },
    async list(): Promise<BotContainerStatus[]> {
      return [];
    },
    async templateDrift() {
      return { drifted: false, fields: [] };
    },
    async create() {},
    async recreate() {},
    async writeProfile() {},
    async start() {},
    async restart() {},
    async stop() {},
  };
}

describe("site-registry — versioning", () => {
  it("increments registry version on bump", () => {
    const v1 = getFleetRegistryVersion();
    const v2 = bumpFleetRegistryVersion();
    expect(v2).toBe(v1 + 1);
    expect(getFleetRegistryVersion()).toBe(v2);
  });
});

describe("site-registry — createFleetClientManager", () => {
  it("resolves tokenSecret and client certificates, building mTLS agents for https sites", async () => {
    const sites: FleetSite[] = [
      {
        id: "site-1",
        companyId: "company-1",
        name: "myr-vm1",
        url: "https://10.10.0.110:9443",
        tokenSecret: "myr-vm1-token",
        caCert: "-----BEGIN CERTIFICATE-----\nFAKE CA\n-----END CERTIFICATE-----",
        clientCertSecretKey: "myr-vm1-client-key",
        status: "active",
        capacity: { maxCpus: 8, maxMemoryMb: 32768 },
        profile: {},
        enrolledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "site-2",
        companyId: "company-1",
        name: "local-fleet",
        url: "http://127.0.0.1:9100",
        tokenSecret: "local-token",
        status: "active",
        capacity: { maxCpus: 4, maxMemoryMb: 16384 },
        profile: {},
        enrolledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "site-3",
        companyId: "company-1",
        name: "inactive-site",
        url: "http://127.0.0.1:9200",
        status: "disabled",
        capacity: { maxCpus: 2, maxMemoryMb: 8192 },
        profile: {},
        enrolledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const fakeDb = {
      select: () => ({
        from: () => Promise.resolve(sites),
      }),
    } as any;

    const secretStore: Record<string, string> = {
      "myr-vm1-token": "secret-token-val-123",
      "myr-vm1-client-key": "-----BEGIN PRIVATE KEY-----\nFAKE KEY\n-----END PRIVATE KEY-----",
      "local-token": "local-token-val-456",
    };

    const createdConfigs: FleetdDriverConfig[] = [];
    const manager = createFleetClientManager({
      db: fakeDb,
      readCompanySecret: async (_cid, name) => secretStore[name] ?? null,
      createDriver: (config) => {
        createdConfigs.push(config);
        return fakeDriver(config.baseUrl);
      },
    });

    const clients = await manager.refresh();
    expect(clients.has("myr-vm1")).toBe(true);
    expect(clients.has("local-fleet")).toBe(true);
    expect(clients.has("inactive-site")).toBe(false);

    const httpsConfig = createdConfigs.find((c) => c.baseUrl === "https://10.10.0.110:9443");
    expect(httpsConfig).toBeDefined();
    expect(httpsConfig!.token).toBe("secret-token-val-123");
    expect(httpsConfig!.caCert).toContain("FAKE CA");
    expect(httpsConfig!.clientKey).toContain("FAKE KEY");
    expect(httpsConfig!.httpsAgent).toBeDefined();

    const httpConfig = createdConfigs.find((c) => c.baseUrl === "http://127.0.0.1:9100");
    expect(httpConfig).toBeDefined();
    expect(httpConfig!.token).toBe("local-token-val-456");
    expect(httpConfig!.httpsAgent).toBeUndefined();

    manager.close();
    expect(manager.getClients().size).toBe(0);
  });

  it("handles database errors gracefully during refresh without throwing", async () => {
    const fakeDb = {
      select: () => ({
        from: () => Promise.reject(new Error("DB connection timeout")),
      }),
    } as any;

    const loggedErrors: any[] = [];
    const manager = createFleetClientManager({
      db: fakeDb,
      log: {
        info: () => {},
        warn: () => {},
        error: (fields, msg) => loggedErrors.push({ fields, msg }),
      },
    });

    const clients = await manager.refresh();
    expect(clients.size).toBe(0);
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0].msg).toContain("failed to refresh fleet sites");
  });
});
