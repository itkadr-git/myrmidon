import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  bumpFleetRegistryVersion,
  createFleetClientManager,
  deleteFleetAffinity,
  getFleetRegistryVersion,
  parseTlsCredentials,
  type FleetSite,
  type FleetSiteInsert,
} from "./site-registry.js";
import type { BotContainerDriver, BotContainerStatus } from "./driver.js";
import { fleetSiteKey } from "./fleetd-hosts.js";
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

describe("site-registry — parseTlsCredentials", () => {
  it("parses JSON bundle with cert and key", () => {
    const res = parseTlsCredentials(
      JSON.stringify({ cert: "mock-cert-c1", key: "mock-key-k1" }),
    );
    expect(res.cert).toBe("mock-cert-c1");
    expect(res.key).toBe("mock-key-k1");
  });

  it("parses combined PEM bundle with certificate and private key blocks", () => {
    const certBlock = ["-----BEGIN", "CERTIFICATE-----", "CERT_DATA", "-----END", "CERTIFICATE-----"].join("\n");
    const keyBlock = ["-----BEGIN", "PRIVATE", "KEY-----", "KEY_DATA", "-----END", "PRIVATE", "KEY-----"].join("\n");
    const combined = `${certBlock}\n${keyBlock}`;
    const res = parseTlsCredentials(combined);
    expect(res.cert).toContain("CERT_DATA");
    expect(res.key).toContain("KEY_DATA");
  });

  it("handles single certificate PEM and single key PEM", () => {
    const certBlock = ["-----BEGIN", "CERTIFICATE-----", "CERT_DATA", "-----END", "CERTIFICATE-----"].join("\n");
    const certOnly = parseTlsCredentials(certBlock);
    expect(certOnly.cert).toContain("CERT_DATA");
    expect(certOnly.key).toBeUndefined();

    const keyBlock = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----", "KEY_DATA", "-----END", "RSA", "PRIVATE", "KEY-----"].join("\n");
    const keyOnly = parseTlsCredentials(keyBlock);
    expect(keyOnly.cert).toBeUndefined();
    expect(keyOnly.key).toContain("KEY_DATA");
  });
});

describe("site-registry — createFleetClientManager", () => {
  it("resolves tokenSecret and client certificates, building mTLS agents for https sites", async () => {
    const sites: FleetSite[] = [
      {
        id: "site-1",
        companyId: "company-1",
        name: "myr-vm1",
        url: "https://myr-vm1.example.test:9443",
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
      "myr-vm1-client-key": "fake-client-key",
      "myr-vm1-client-cert": "fake-client-cert",
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
    expect(clients.has(fleetSiteKey("company-1", "myr-vm1"))).toBe(true);
    expect(clients.has(fleetSiteKey("company-1", "local-fleet"))).toBe(true);
    expect(clients.has(fleetSiteKey("company-1", "inactive-site"))).toBe(false);

    const httpsConfig = createdConfigs.find((c) => c.baseUrl === "https://myr-vm1.example.test:9443");
    expect(httpsConfig).toBeDefined();
    expect(httpsConfig!.token).toBe("secret-token-val-123");
    expect(httpsConfig!.caCert).toContain("FAKE CA");
    expect(httpsConfig!.clientCert).toContain("fake-client-cert");
    expect(httpsConfig!.clientKey).toContain("fake-client-key");
    expect(httpsConfig!.httpsAgent).toBeDefined();

    const agentOptions = (httpsConfig!.httpsAgent as any).options;
    expect(agentOptions.ca).toContain("FAKE CA");
    expect(agentOptions.cert).toContain("fake-client-cert");
    expect(agentOptions.key).toContain("fake-client-key");
    expect(agentOptions.rejectUnauthorized).toBe(true);

    const httpConfig = createdConfigs.find((c) => c.baseUrl === "http://127.0.0.1:9100");
    expect(httpConfig).toBeDefined();
    expect(httpConfig!.token).toBe("local-token-val-456");
    expect(httpConfig!.httpsAgent).toBeUndefined();

    manager.close();
    expect(manager.getClients().size).toBe(0);
  });

  it("resolves client certificate and private key from a single JSON bundle secret", async () => {
    const sites: FleetSite[] = [
      {
        id: "site-bundle",
        companyId: "company-1",
        name: "myr-bundle",
        url: "https://myr-vm1.example.test:9443",
        clientCertSecretKey: "myr-bundle-secret",
        caCert: "-----BEGIN CERTIFICATE-----\nBUNDLE CA\n-----END CERTIFICATE-----",
        status: "active",
        capacity: { maxCpus: 4, maxMemoryMb: 16384 },
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
      "myr-bundle-secret": JSON.stringify({
        cert: "bundle-client-cert",
        key: "bundle-client-key",
      }),
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

    await manager.refresh();
    const config = createdConfigs.find((c) => c.baseUrl === "https://myr-vm1.example.test:9443");
    expect(config).toBeDefined();
    expect(config!.clientCert).toContain("bundle-client-cert");
    expect(config!.clientKey).toContain("bundle-client-key");

    const agentOptions = (config!.httpsAgent as any).options;
    expect(agentOptions.cert).toContain("bundle-client-cert");
    expect(agentOptions.key).toContain("bundle-client-key");
    expect(agentOptions.ca).toContain("BUNDLE CA");
    expect(agentOptions.rejectUnauthorized).toBe(true);

    manager.close();
  });

  it("uses clientCert stored directly in the database row alongside a key secret", async () => {
    const sites: FleetSite[] = [
      {
        id: "site-row",
        companyId: "company-1",
        name: "myr-direct",
        url: "https://myr-vm1.example.test:9443",
        clientCert: "row-client-cert",
        clientCertSecretKey: "myr-row-key",
        status: "active",
        capacity: { maxCpus: 4, maxMemoryMb: 16384 },
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
      "myr-row-key": "row-client-key",
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

    await manager.refresh();
    const config = createdConfigs.find((c) => c.baseUrl === "https://myr-vm1.example.test:9443");
    expect(config).toBeDefined();
    expect(config!.clientCert).toContain("row-client-cert");
    expect(config!.clientKey).toContain("row-client-key");

    const agentOptions = (config!.httpsAgent as any).options;
    expect(agentOptions.cert).toContain("row-client-cert");
    expect(agentOptions.key).toContain("row-client-key");
    expect(agentOptions.rejectUnauthorized).toBe(true);

    manager.close();
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

describe("site-registry — tenant isolation", () => {
  const mkSite = (companyId: string, url: string): FleetSite =>
    ({
      id: `site-${companyId}`,
      companyId,
      name: "myr-vm1",
      url,
      status: "active",
      capacity: { maxCpus: 2, maxMemoryMb: 8192 },
      profile: {},
      enrolledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as FleetSite;

  it("keeps same-named sites of two companies as separate clients", async () => {
    const sites = [mkSite("company-a", "http://127.0.0.1:9101"), mkSite("company-b", "http://127.0.0.1:9102")];
    const fakeDb = { select: () => ({ from: () => Promise.resolve(sites) }) } as any;
    const manager = createFleetClientManager({
      db: fakeDb,
      readCompanySecret: async () => null,
      createDriver: (config) => Object.assign(fakeDriver(config.baseUrl), { baseUrl: config.baseUrl }),
    });
    const clients = await manager.refresh();
    expect(clients.size).toBe(2);
    expect((clients.get(fleetSiteKey("company-a", "myr-vm1")) as any).baseUrl).toBe("http://127.0.0.1:9101");
    expect((clients.get(fleetSiteKey("company-b", "myr-vm1")) as any).baseUrl).toBe("http://127.0.0.1:9102");
    expect(clients.has("myr-vm1")).toBe(false);
  });

  it("deleteFleetAffinity filters by companyId as well as id", async () => {
    const wheres: unknown[] = [];
    const fakeDb = {
      delete: () => ({
        where: (cond: unknown) => {
          wheres.push(cond);
          return { returning: async () => [] };
        },
      }),
    } as any;
    // Foreign company's row is not matched: the DELETE carries a company predicate.
    expect(await deleteFleetAffinity(fakeDb, "company-a", "aff-of-company-b")).toBe(false);
    const query = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(query.sql).toContain("company_id");
    expect(query.params).toEqual(["company-a", "aff-of-company-b"]);
  });
});
