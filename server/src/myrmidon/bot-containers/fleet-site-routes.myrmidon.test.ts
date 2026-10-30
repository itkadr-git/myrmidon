// myrmidon(1.6.6 OPE-8999): enrolling an execution site through the API, no manual INSERT.

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

function harness(
  secrets: string[] = ["fleetd-myr-vm1-token", "fleetd-myr-vm1-client-cert", "fleetd-myr-vm1-client-key", "myrmidon-site-ca"],
  opts: {
    bots?: number;
    secretValues?: Record<string, string>;
    siteCa?: ReturnType<typeof generateSiteCa> | null;
    logMessages?: string[];
  } = {},
) {
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
  const deps: FleetSiteRoutesDeps & { rows: FleetSite[]; logEntries: typeof logEntries } = {
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
    secretExists: vi.fn(async (_companyId: string, name: string) => secrets.includes(name)),
    writeSecret: vi.fn(async (_companyId: string, _name: string, _value: string) => undefined),
    deleteSecret: vi.fn(async (_companyId: string, _name: string) => undefined),
    refreshRegistry: vi.fn(),
    updateSite: vi.fn(async (companyId: string, name: string, patch: Partial<FleetSite>) => {
      const row = rows.find((site) => site.companyId === companyId && site.name === name);
      if (row) Object.assign(row, patch);
    }),
    readClientCertificate: vi.fn(async (_companyId: string, _name: string): Promise<string | null> => null),
    log: {
      warn: vi.fn((objOrMsg, msg) => recordLog("warn", objOrMsg, msg)),
      error: vi.fn((objOrMsg, msg) => recordLog("error", objOrMsg, msg)),
      info: vi.fn((objOrMsg, msg) => recordLog("info", objOrMsg, msg)),
    },
  };
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = who === "agent" ? agentActor : actors[typeof who === "string" ? who : "admin"];
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
    tokenSecret: "fleetd-myr-vm1-token",
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
    const { app, deps } = harness(undefined, { siteCa: null });
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
    const { app, deps } = harness(undefined, { siteCa: ca });
    const response = await request(app).post(path).send(body()).expect(201);
    const site = deps.createSite.mock.calls[0]![0];
    expect(site.clientCertFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(site.clientCertNotAfter).toBeInstanceOf(Date);
    expect(site.clientCertNotAfter!.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    expect(site.clientCertNotAfter!.getTime() - Date.now()).toBeLessThanOrEqual(90 * 86_400_000);
    const returned = JSON.stringify(response.body);
    expect(deps.writeSecret).toHaveBeenCalledTimes(1);
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
    const { app, deps } = harness(undefined, { siteCa: ca, logMessages });

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
    const { app, deps } = harness(undefined, { siteCa: null });
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
    const { app, deps } = harness(undefined, { siteCa: ca });
    await request(app).post(path).send(body()).expect(201);
    const writesBeforeGet = deps.writeSecret.mock.calls.length;

    const site = deps.createSite.mock.calls[0]![0] as unknown as FleetSite;
    site.clientCertNotAfter = new Date(Date.now() + 86_400_000); // near expiry

    // GET request should not write any secrets
    await request(app).get(path).expect(200);
    expect(deps.writeSecret).toHaveBeenCalledTimes(writesBeforeGet);
  });

  it("renews an expiring client certificate and updates its fingerprint via rotateDueFleetSiteCertificates", async () => {
    const ca = generateSiteCa();
    const client = issueSiteClientCertificate(ca, "test-site", new Date(Date.now() - 89 * 86_400_000));
    const { app, deps } = harness(undefined, { siteCa: ca });
    const callsBeforeRotation = deps.writeSecret.mock.calls.length;
    await request(app).post(path).send(body()).expect(201);
    const site = deps.createSite.mock.calls[0]![0] as unknown as FleetSite;
    site.clientCertNotAfter = new Date(Date.now() + 86_400_000);
    deps.readClientCertificate.mockResolvedValue(client.cert);

    await rotateDueFleetSiteCertificates(deps, COMPANY_A);

    expect(deps.writeSecret).toHaveBeenCalledTimes(callsBeforeRotation + 2);
    expect(deps.writeSecret).toHaveBeenLastCalledWith(COMPANY_A, "myrmidon-site-client-myr-vm1", expect.stringContaining("CERTIFICATE"));
    expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "myr-vm1", expect.objectContaining({
      clientCertFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("isolates errors per site during certificate rotation so one failing site does not block others", async () => {
    const ca = generateSiteCa();
    const { deps } = harness(undefined, { siteCa: ca });
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
    };
    deps.listSites.mockResolvedValue([siteA, siteB]);

    // Make site-a rotation throw error
    deps.writeSecret.mockImplementation(async (_cid, name) => {
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
    const { app, deps } = harness(undefined, { siteCa: ca });
    await request(app).post(path).send(body()).expect(201);
    const callsBeforeRotation = deps.writeSecret.mock.calls.length;

    // Simulate certificate nearing expiry
    const site = deps.createSite.mock.calls[0]![0] as unknown as FleetSite;
    site.clientCertNotAfter = new Date(Date.now() + 86_400_000);
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

  it("rejects when the token secret is missing", async () => {
    const { app, deps } = harness([]);
    await request(app).post(path).send(body()).expect(400);
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

  it("lets a company owner, company admin and instance admin enroll and delete", async () => {
    for (const who of ["admin", "owner", "instance"]) {
      const { app } = harness();
      await request(app).post(path).set("x-test-actor", who).send(body()).expect(201);
      await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", who).expect(204);
    }
  });

  it("refuses to delete a site that still hosts bots", async () => {
    const { app, deps } = harness(undefined, { bots: 2 });
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

describe("fleet site helpers", () => {
  it("normalizes a fleetd url to its origin", () => {
    expect(normalizeFleetdUrl("https://fleetd.internal:9100/")).toBe("https://fleetd.internal:9100");
  });
});
