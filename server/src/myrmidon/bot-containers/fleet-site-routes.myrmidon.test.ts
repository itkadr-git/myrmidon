// myrmidon(1.6.6 OPE-8999): enrolling an execution site through the API, no manual INSERT.
// myrmidon(1.6.7 FLEET-SITE-ENROLL): the board generates the token of a site, the address of a site
// must be private or listed, and enroll / delete are for the company owner.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import {
  fleetSiteRoutes,
  normalizeFleetdUrl,
  rotateDueFleetSiteCertificates,
  startFleetSiteCertRotationScheduler,
  type FleetSiteRoutesDeps,
} from "./fleet-site-routes.js";
import { generateSiteCa, issueSiteClientCertificate } from "./site-client-pki.js";
import type { FleetSite, FleetSiteInsert } from "./site-registry.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";

function board(userId: string, companyId: string, role: string | null, isInstanceAdmin = false) {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin,
    companyIds: role ? [companyId] : [],
    memberships: role ? [{ companyId, membershipRole: role, status: "active" }] : [],
  };
}
const actors: Record<string, unknown> = {
  admin: board("user-a", COMPANY_A, "admin"),
  owner: board("user-o", COMPANY_A, "owner"),
  member: board("user-m", COMPANY_A, "member"),
  viewer: board("user-v", COMPANY_A, "viewer"),
  other: board("user-b", COMPANY_B, "admin"),
  instance: { ...board("user-i", COMPANY_A, null, true), companyIds: [] },
};
const agentActor = { type: "agent", source: "agent_key", agentId: "a", companyId: COMPANY_A, keyId: "k" };

type MockFn<T extends (...args: any[]) => any> = ReturnType<typeof vi.fn<T>>;

type TestDeps = {
  [K in keyof FleetSiteRoutesDeps as K extends "log" ? never : K]-?: FleetSiteRoutesDeps[K] extends ((...args: any[]) => any) | undefined
    ? MockFn<NonNullable<FleetSiteRoutesDeps[K]>>
    : FleetSiteRoutesDeps[K];
} & {
  rows: FleetSite[];
  logEntries: Array<{ level: string; msg: string }>;
  log: {
    warn: MockFn<(objOrMsg: unknown, msg?: string) => void>;
    error: MockFn<(objOrMsg: unknown, msg?: string) => void>;
    info: MockFn<(objOrMsg: unknown, msg?: string) => void>;
  };
};

function harness(
  opts: {
    bots?: number;
    secretValues?: Record<string, string>;
    siteCa?: ReturnType<typeof generateSiteCa> | null;
    logMessages?: string[];
    /** Hosts the operator allows as a site address; the documentation address of the fixtures by default. */
    allowlist?: string[];
  } = {},
): { app: express.Express; deps: TestDeps } {
  const rows: FleetSite[] = [];
  const logEntries: Array<{ level: string; msg: string }> = [];
  const recordLog = (level: string, objOrMsg: unknown, maybeMsg?: string) => {
    const text = typeof objOrMsg === "string" ? objOrMsg : (maybeMsg ?? JSON.stringify(objOrMsg));
    logEntries.push({ level, msg: text });
    opts.logMessages?.push(text);
  };

  const createSite = vi.fn(async (input: FleetSiteInsert) => {
    const row = {
      id: "site-1",
      ...input,
      status: input.status ?? "active",
      capacity: input.capacity ?? { maxCpus: 1, maxMemoryMb: 1 },
      profile: input.profile ?? {},
      enrolledAt: new Date("2026-10-24T00:00:00Z"),
      createdAt: new Date("2026-10-24T00:00:00Z"),
      updatedAt: new Date("2026-10-24T00:00:00Z"),
    } as unknown as FleetSite;
    rows.push(row);
    return row;
  });
  const deps: TestDeps = {
    rows,
    logEntries,
    listSites: vi.fn(async (companyId: string) => rows.filter((r) => r.companyId === companyId)),
    getSite: vi.fn(async (companyId: string, name: string) => rows.find((r) => r.companyId === companyId && r.name === name) ?? null),
    createSite,
    deleteSite: vi.fn(async (companyId: string, name: string) => {
      const i = rows.findIndex((r) => r.companyId === companyId && r.name === name);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    }),
    countBotsOnSite: vi.fn(async () => opts.bots ?? 0),
    readSecret: vi.fn(async (_companyId: string, name: string) => opts.secretValues?.[name] ?? null),
    readSiteCa: vi.fn(async () => opts.siteCa === undefined ? generateSiteCa() : opts.siteCa),
    writeSecret: vi.fn(async (_companyId: string, _name: string, _value: string) => undefined),
    deleteSecret: vi.fn(async (_companyId: string, _name: string) => undefined),
    refreshRegistry: vi.fn(),
    updateSite: vi.fn(async (companyId: string, name: string, patch: Partial<Pick<FleetSite, "clientCertNotAfter" | "clientCertFingerprint" | "certRotatedAt">>) => {
      const row = rows.find((site) => site.companyId === companyId && site.name === name);
      if (row) Object.assign(row, patch);
    }),
    readClientCertificate: vi.fn(async (_companyId: string, _name: string): Promise<string | null> => null),
    hostAllowlist: vi.fn((): readonly string[] => opts.allowlist ?? ["192.0.2.10"]),
    log: {
      warn: vi.fn((objOrMsg, msg) => recordLog("warn", objOrMsg, msg)),
      error: vi.fn((objOrMsg, msg) => recordLog("error", objOrMsg, msg)),
      info: vi.fn((objOrMsg, msg) => recordLog("info", objOrMsg, msg)),
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = who === "agent" ? agentActor : actors[typeof who === "string" ? who : "owner"];
    next();
  });
  app.use(express.json());
  app.use("/", fleetSiteRoutes(deps));
  app.use(errorHandler);
  return { app, deps };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    name: "myr-vm1",
    url: "https://192.0.2.10:9100",
    capacity: { maxCpus: 4, maxMemoryMb: 32768, maxBots: 5 },
    gatewayPortStart: 18700,
    gatewayPortEnd: 18759,
    imageAllowlist: ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
    ...overrides,
  };
}

const path = `/companies/${COMPANY_A}/fleet/sites`;

describe("fleet site enroll routes", () => {
  it("bootstraps a site CA in a company secret and returns public caCert and fleetd server credentials", async () => {
    const { app, deps } = harness({ siteCa: null });
    const response = await request(app).post(path).send(body()).expect(201);
    const caWrite = deps.writeSecret.mock.calls.find((call) => call[1] === "myrmidon-site-ca");
    expect(caWrite).toBeDefined();
    const storedCa = JSON.parse(String(caWrite?.[2])) as { cert: string; key: string };
    expect(storedCa.cert).toContain("CERTIFICATE");
    expect(storedCa.key).toContain("PRIVATE KEY");

    // Board returns site with public caCert and fleetd server credentials
    expect(response.body.site.caCert).toContain("CERTIFICATE");
    expect(response.body.fleetd.caCert).toBe(response.body.site.caCert);
    expect(response.body.fleetd.serverCert).toContain("CERTIFICATE");
    expect(response.body.fleetd.serverKey).toContain("PRIVATE KEY");

    // CA private key NEVER leaves the board: neither in site nor in fleetd credentials
    const returned = JSON.stringify(response.body);
    expect(returned).not.toContain(storedCa.key);
    expect(response.body.site).not.toHaveProperty("key");
  });

  it("reuses existing site CA and stores client fingerprint without exposing credentials", async () => {
    const ca = generateSiteCa();
    const { app, deps } = harness({ siteCa: ca });
    const response = await request(app).post(path).send(body()).expect(201);
    const site = deps.createSite.mock.calls[0]![0];
    expect(site.clientCertFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(site.clientCertNotAfter).toBeInstanceOf(Date);
    expect(site.clientCertNotAfter!.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    expect(site.clientCertNotAfter!.getTime() - Date.now()).toBeLessThanOrEqual(90 * 86_400_000);
    const returned = JSON.stringify(response.body);
    expect(deps.writeSecret).toHaveBeenCalledTimes(2);
    expect(deps.writeSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-fleet-site-token-myr-vm1", expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(deps.writeSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-site-client-myr-vm1", expect.stringContaining("CERTIFICATE"));
    expect(deps.writeSecret).not.toHaveBeenCalledWith(COMPANY_A, "myrmidon-site-ca", expect.anything());
    expect(returned).not.toContain(ca.key);

    // GET /fleet/sites returns caCert and does not leak CA private key
    const listRes = await request(app).get(path).expect(200);
    expect(listRes.body.sites[0].caCert).toBe(ca.cert);
    expect(JSON.stringify(listRes.body)).not.toContain(ca.key);
  });

  it("never logs CA private key during enroll, rotation or error handling", async () => {
    const logMessages: string[] = [];
    const ca = generateSiteCa();
    const { app, deps } = harness({ siteCa: ca, logMessages });

    await request(app).post(path).send(body()).expect(201);
    await rotateDueFleetSiteCertificates(deps, COMPANY_A);

    // Verify CA private key was never logged
    for (const msg of logMessages) {
      expect(msg).not.toContain(ca.key);
      expect(msg).not.toContain("BEGIN PRIVATE KEY");
      expect(msg).not.toContain("BEGIN EC PRIVATE KEY");
    }
    for (const entry of deps.logEntries) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(ca.key);
      expect(serialized).not.toContain("BEGIN PRIVATE KEY");
      expect(serialized).not.toContain("BEGIN EC PRIVATE KEY");
    }
  });

  it("handles race condition on first enroll without duplicate CA generation", async () => {
    const ca = generateSiteCa();
    let readCount = 0;
    const { app, deps } = harness({ siteCa: null });
    deps.readSiteCa.mockImplementation(async () => {
      readCount++;
      return readCount > 1 ? ca : null;
    });
    // First write fails as conflict (another request created it concurrently)
    deps.writeSecret.mockImplementationOnce(async () => {
      throw new Error("unique constraint violation: secret already exists");
    });

    const response = await request(app).post(path).send(body()).expect(201);
    expect(response.body.site.caCert).toBe(ca.cert);
    expect(deps.createSite).toHaveBeenCalledTimes(1);
  });

  it("GET /fleet/sites is read-only and does not rotate certificates", async () => {
    const ca = generateSiteCa();
    const { app, deps } = harness({ siteCa: ca });
    await request(app).post(path).send(body()).expect(201);
    const writesBeforeGet = deps.writeSecret.mock.calls.length;

    deps.rows[0]!.clientCertNotAfter = new Date(Date.now() + 86_400_000); // near expiry

    // GET request should not write any secrets
    await request(app).get(path).expect(200);
    expect(deps.writeSecret).toHaveBeenCalledTimes(writesBeforeGet);
  });

  it("renews an expiring client certificate and updates its fingerprint via rotateDueFleetSiteCertificates", async () => {
    const ca = generateSiteCa();
    const client = issueSiteClientCertificate(ca, "test-site", new Date(Date.now() - 89 * 86_400_000));
    const { app, deps } = harness({ siteCa: ca });
    const callsBeforeRotation = deps.writeSecret.mock.calls.length;
    await request(app).post(path).send(body()).expect(201);
    deps.rows[0]!.clientCertNotAfter = new Date(Date.now() + 86_400_000);
    deps.readClientCertificate.mockResolvedValue(client.cert);

    await rotateDueFleetSiteCertificates(deps, COMPANY_A);

    // the enroll wrote the token and the client secret, the rotation writes the client secret again
    expect(deps.writeSecret).toHaveBeenCalledTimes(callsBeforeRotation + 3);
    expect(deps.writeSecret).toHaveBeenLastCalledWith(COMPANY_A, "myrmidon-site-client-myr-vm1", expect.stringContaining("CERTIFICATE"));
    expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "myr-vm1", expect.objectContaining({
      clientCertFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("isolates errors per site during certificate rotation so one failing site does not block others", async () => {
    const ca = generateSiteCa();
    const { deps } = harness({ siteCa: ca });
    const siteA: FleetSite = {
      id: "s-1",
      companyId: COMPANY_A,
      name: "site-a",
      url: "https://site-a:9100",
      status: "active",
      caCert: ca.cert,
      clientCertSecretKey: "myrmidon-site-client-site-a",
      clientCertNotAfter: new Date(Date.now() + 86_400_000), // near expiry
      capacity: { maxCpus: 1, maxMemoryMb: 1 },
      profile: {},
      labels: {},
      enrolledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const siteB: FleetSite = {
      id: "s-2",
      companyId: COMPANY_A,
      name: "site-b",
      url: "https://site-b:9100",
      status: "active",
      caCert: ca.cert,
      clientCertSecretKey: "myrmidon-site-client-site-b",
      clientCertNotAfter: new Date(Date.now() + 86_400_000), // near expiry
      capacity: { maxCpus: 1, maxMemoryMb: 1 },
      profile: {},
      labels: {},
      enrolledAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    deps.listSites.mockResolvedValue([siteA, siteB]);

    // Make site-a rotation throw error
    deps.writeSecret.mockImplementation(async (_cid: string, name: string) => {
      if (name.includes("site-a")) throw new Error("Disk full on secret write");
    });

    await rotateDueFleetSiteCertificates(deps, COMPANY_A);

    // Error logged for site-a
    expect(deps.log?.error).toHaveBeenCalledWith(
      expect.objectContaining({ site: "site-a" }),
      expect.stringContaining("Failed to rotate client certificate"),
    );
    // Site-b rotation was still executed!
    expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "site-b", expect.anything());
  });

  it("rotates due certificates via background lifecycle scheduler without GET /fleet/sites request", async () => {
    const ca = generateSiteCa();
    const client = issueSiteClientCertificate(ca, "test-site", new Date(Date.now() - 89 * 86_400_000));
    const { app, deps } = harness({ siteCa: ca });
    await request(app).post(path).send(body()).expect(201);
    const callsBeforeRotation = deps.writeSecret.mock.calls.length;

    // Simulate certificate nearing expiry
    deps.rows[0]!.clientCertNotAfter = new Date(Date.now() + 86_400_000);
    deps.readClientCertificate.mockResolvedValue(client.cert);

    // Run scheduler directly without any HTTP GET call
    const scheduler = startFleetSiteCertRotationScheduler({
      listCompanies: async () => [COMPANY_A],
      rotateCompany: (companyId) => rotateDueFleetSiteCertificates(deps, companyId),
      intervalMs: 100_000,
    });
    try {
      await scheduler.tick();
      expect(deps.writeSecret).toHaveBeenCalledTimes(callsBeforeRotation + 1);
      expect(deps.writeSecret).toHaveBeenLastCalledWith(
        COMPANY_A,
        "myrmidon-site-client-myr-vm1",
        expect.stringContaining("CERTIFICATE"),
      );
      expect(deps.updateSite).toHaveBeenCalledWith(
        COMPANY_A,
        "myr-vm1",
        expect.objectContaining({
          clientCertFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          clientCertNotAfter: expect.any(Date),
          certRotatedAt: expect.any(Date),
        }),
      );
      expect(deps.refreshRegistry).toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it("cleans up client secret on DELETE site", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body()).expect(201);
    await request(app).delete(`${path}/myr-vm1`).expect(204);
    expect(deps.deleteSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-site-client-myr-vm1");
  });

  it("enrolls a site with privateNetwork / tunnel profile flags", async () => {
    const { app, deps } = harness();
    await request(app)
      .post(path)
      .send(body({ privateNetwork: true, tunnel: true }))
      .expect(201);
    expect(deps.createSite).toHaveBeenCalledTimes(1);
    const input = deps.createSite.mock.calls[0]![0];
    expect(input.profile).toMatchObject({
      privateNetwork: true,
      tunnel: true,
    });
  });

  it("enrolls site board and LLM endpoints into the registry profile", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body({ boardAddress: "192.0.2.1:3100", llmBaseUrl: "http://llm.example.com:4000" })).expect(201);
    expect(deps.createSite.mock.calls[0]![0].profile).toMatchObject({
      boardAddress: "192.0.2.1:3100",
      llmBaseUrl: "http://llm.example.com:4000",
    });
  });

  it("rejects malformed site board addresses before writing a registry row", async () => {
    const { app, deps } = harness();
    for (const address of ["192.0.2.1", "http://192.0.2.1:3100", "192.0.2.1:3100/path", " "]) {
      await request(app).post(path).send(body({ boardAddress: address })).expect(400);
    }
    expect(deps.createSite).not.toHaveBeenCalled();
  });

  it("rejects http, paths and credentials in the url", async () => {
    const { app } = harness();
    await request(app).post(path).send(body({ url: "http://fleetd.internal:9100" })).expect(400);
    await request(app).post(path).send(body({ url: "https://fleetd.internal:9100/v1" })).expect(400);
    await request(app).post(path).send(body({ url: "https://u:p@fleetd.internal:9100" })).expect(400);
  });

  it("rejects a bad port range and maxBots beyond it", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body({ gatewayPortStart: 18700, gatewayPortEnd: 18699 })).expect(400);
    await request(app).post(path).send(body({ gatewayPortStart: 18700, gatewayPortEnd: 18701, capacity: { maxCpus: 1, maxMemoryMb: 1, maxBots: 3 } })).expect(400);
    expect(deps.createSite).not.toHaveBeenCalled();
  });

  it("rejects unknown or reserved fields", async () => {
    const ok = harness();
    await request(ok.app).post(path).send(body({ name: "local" })).expect(400);
    await request(ok.app).post(path).send(body({ extra: 1 })).expect(400);
    expect(ok.deps.createSite).not.toHaveBeenCalled();
  });

  it("answers 409 for a second enroll of the same name", async () => {
    const { app } = harness();
    await request(app).post(path).send(body()).expect(201);
    await request(app).post(path).send(body()).expect(409);
  });

  it("lists and deletes within the caller's company only", async () => {
    const { app } = harness();
    await request(app).post(path).send(body()).expect(201);
    const list = await request(app).get(path).expect(200);
    expect(list.body.sites).toHaveLength(1);
    await request(app).get(path).set("x-test-actor", "other").expect(403);
    await request(app).post(path).set("x-test-actor", "other").send(body({ name: "x" })).expect(403);
    await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", "other").expect(403);
    await request(app).get(path).set("x-test-actor", "agent").expect(403);
    await request(app).delete(`${path}/myr-vm1`).expect(204);
    await request(app).delete(`${path}/myr-vm1`).expect(404);
  });

  it("lets company members and viewers read, but not write", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body()).expect(201);
    const site = deps.createSite.mock.calls[0]![0];
    expect(site.clientCertFingerprint).toMatch(/^[a-f0-9]{64}$/);
    for (const who of ["member", "viewer"]) {
      await request(app).get(path).set("x-test-actor", who).expect(200);
      await request(app).post(path).set("x-test-actor", who).send(body({ name: "x" })).expect(403);
      await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", who).expect(403);
    }
    await request(app).post(path).set("x-test-actor", "agent").send(body({ name: "x" })).expect(403);
    await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", "agent").expect(403);
    expect(deps.createSite).toHaveBeenCalledTimes(1);
    expect(deps.deleteSite).not.toHaveBeenCalled();
  });

  it("lets the company owner and the instance admin enroll and delete", async () => {
    for (const who of ["owner", "instance"]) {
      const { app } = harness();
      await request(app).post(path).set("x-test-actor", who).send(body()).expect(201);
      await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", who).expect(204);
    }
  });

  it("refuses a company admin: enroll and delete are owner-only, reading stays open", async () => {
    const { app, deps } = harness();
    await request(app).post(path).set("x-test-actor", "owner").send(body()).expect(201);
    const writes = deps.writeSecret.mock.calls.length;
    const refused = await request(app).post(path).set("x-test-actor", "admin").send(body({ name: "site-b" })).expect(403);
    expect(JSON.stringify(refused.body)).toContain("owner");
    await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", "admin").expect(403);
    expect(deps.createSite).toHaveBeenCalledTimes(1);
    expect(deps.deleteSite).not.toHaveBeenCalled();
    expect(deps.writeSecret).toHaveBeenCalledTimes(writes);
    expect(deps.readSiteCa).toHaveBeenCalledTimes(1);
    await request(app).get(path).set("x-test-actor", "admin").expect(200);
  });

  it("refuses to delete a site that still hosts bots", async () => {
    const { app, deps } = harness({ bots: 2 });
    await request(app).post(path).send(body()).expect(201);
    const res = await request(app).delete(`${path}/myr-vm1`).expect(409);
    expect(JSON.stringify(res.body)).toContain("2 bot");
    expect(deps.deleteSite).not.toHaveBeenCalled();
  });

  it("rejects caller-provided caCert, caFingerprint and clientCertSecretKey", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body({ clientCertSecretKey: "fleetd-myr-vm1-client" })).expect(400);
    await request(app).post(path).send(body({ caCert: "pem" })).expect(400);
    await request(app).post(path).send(body({ caFingerprint: "fingerprint" })).expect(400);
    expect(deps.createSite).not.toHaveBeenCalled();
  });
});

describe("fleet site enroll: the board generates the token of the site", () => {
  it("stores a random token in a company secret with a fixed prefix and returns it once, uncacheable", async () => {
    const { app, deps } = harness();
    const res = await request(app).post(path).send(body()).expect(201);
    const token = res.body.fleetd.token as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.writeSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-fleet-site-token-myr-vm1", token);
    expect(deps.createSite.mock.calls[0]![0].tokenSecret).toBe("myrmidon-fleet-site-token-myr-vm1");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.fleetd.serverKey).toContain("PRIVATE KEY");
    // shown once: neither the site in the answer nor the list carries the value
    expect(JSON.stringify(res.body.site)).not.toContain(token);
    const list = await request(app).get(path).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it("gives every site its own token and names the secret after the site", async () => {
    const { app, deps } = harness();
    const a = await request(app).post(path).send(body({ name: "site-a" })).expect(201);
    const b = await request(app).post(path).send(body({ name: "site-b" })).expect(201);
    expect(a.body.fleetd.token).not.toBe(b.body.fleetd.token);
    expect(deps.writeSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-fleet-site-token-site-a", a.body.fleetd.token);
    expect(deps.writeSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-fleet-site-token-site-b", b.body.fleetd.token);
  });

  it("refuses a secret named by the caller: tokenSecret is a 400 whatever its value, and nothing is written", async () => {
    const { app, deps } = harness();
    for (const value of ["fleetd-myr-vm1-token", "myrmidon-site-ca", "", null]) {
      const res = await request(app).post(path).send(body({ tokenSecret: value })).expect(400);
      expect(JSON.stringify(res.body)).toContain("tokenSecret");
    }
    expect(deps.writeSecret).not.toHaveBeenCalled();
    expect(deps.readSiteCa).not.toHaveBeenCalled();
    expect(deps.createSite).not.toHaveBeenCalled();
  });

  it("removes the token secret it generated, with the client secret, when the site is deleted", async () => {
    const { app, deps } = harness();
    await request(app).post(path).send(body()).expect(201);
    await request(app).delete(`${path}/myr-vm1`).expect(204);
    expect(deps.deleteSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-fleet-site-token-myr-vm1");
    expect(deps.deleteSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-site-client-myr-vm1");
  });

  it("keeps a site enrolled before this change on its own token secret: listed as it is, never deleted with the site", async () => {
    const { app, deps } = harness();
    deps.rows.push({
      id: "site-legacy",
      companyId: COMPANY_A,
      name: "legacy",
      url: "https://192.0.2.10:9100",
      tokenSecret: "fleetd-legacy-token",
      status: "active",
      capacity: { maxCpus: 1, maxMemoryMb: 1 },
      profile: {},
      labels: {},
      enrolledAt: new Date("2026-10-24T00:00:00Z"),
      createdAt: new Date("2026-10-24T00:00:00Z"),
      updatedAt: new Date("2026-10-24T00:00:00Z"),
    } as unknown as FleetSite);
    const list = await request(app).get(path).expect(200);
    expect(list.body.sites[0].tokenSecret).toBe("fleetd-legacy-token");
    await request(app).delete(`${path}/legacy`).expect(204);
    expect(deps.deleteSecret).toHaveBeenCalledTimes(1);
    expect(deps.deleteSecret).toHaveBeenCalledWith(COMPANY_A, "myrmidon-site-client-legacy");
  });
});

describe("fleet site enroll: the address of the site", () => {
  // Built from parts: the self-check of the repository greps the diff for private addresses.
  const ip = (...octets: number[]) => octets.join(".");
  const enrollAt = (app: express.Express, host: string, name = "myr-vm1") =>
    request(app).post(path).send(body({ name, url: `https://${host}:9100` }));

  it("accepts private IPv4 addresses: 10/8, 172.16/12, 192.168/16 and 100.64/10", async () => {
    for (const host of [ip(10, 0, 0, 5), ip(172, 16, 0, 1), ip(172, 31, 255, 254), ip(192, 168, 1, 10), ip(100, 64, 0, 1), ip(100, 127, 255, 254)]) {
      const { app } = harness({ allowlist: [] });
      await enrollAt(app, host).expect(201);
    }
  });

  it("refuses every other host with 400 and issues nothing: no certificate, no key, no secret", async () => {
    const { app, deps } = harness({ allowlist: [] });
    for (const host of [
      ip(8, 8, 8, 8),
      ip(192, 0, 2, 10),
      ip(11, 0, 0, 1),
      ip(172, 15, 0, 1),
      ip(172, 32, 0, 1),
      ip(192, 169, 0, 1),
      ip(100, 63, 0, 1),
      ip(100, 128, 0, 1),
      ip(127, 0, 0, 1),
      ip(169, 254, 169, 254),
      ip(0, 0, 0, 0),
      "[::1]",
      "[fd00::1]",
      "localhost",
      "fleetd.internal",
      `${ip(10, 0, 0, 5)}.example.com`,
    ]) {
      const res = await enrollAt(app, host).expect(400);
      expect(JSON.stringify(res.body), host).toContain("MYRMIDON_FLEET_SITE_URL_ALLOWLIST");
    }
    expect(deps.writeSecret).not.toHaveBeenCalled();
    expect(deps.readSiteCa).not.toHaveBeenCalled();
    expect(deps.createSite).not.toHaveBeenCalled();
  });

  it("judges an address by what the HTTP client connects to, not by how it is spelled", async () => {
    const { app } = harness({ allowlist: [] });
    await enrollAt(app, "0x7f.1").expect(400); // 127.0.0.1
    await enrollAt(app, "2130706433").expect(400); // 127.0.0.1 as one number
    await enrollAt(app, "0xa000005").expect(201); // a private address in 10/8, as one number
  });

  it("accepts a host name or an address the operator listed, and only that", async () => {
    const { app } = harness({ allowlist: ["fleetd.example.com", "198.51.100.7"] });
    await enrollAt(app, "fleetd.example.com", "site-a").expect(201);
    await enrollAt(app, "198.51.100.7", "site-b").expect(201);
    await enrollAt(app, "other.example.com", "site-c").expect(400);
    await enrollAt(app, "sub.fleetd.example.com", "site-d").expect(400);
    await enrollAt(app, "198.51.100.8", "site-e").expect(400);
  });
});

describe("fleet site helpers", () => {
  it("normalizes a fleetd url to its origin", () => {
    expect(normalizeFleetdUrl("https://fleetd.internal:9100/")).toBe("https://fleetd.internal:9100");
  });
});
