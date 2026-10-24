// myrmidon(1.6.6 OPE-8999): enrolling an execution site through the API, no manual INSERT.

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import {
  fleetSiteRoutes,
  inspectCaCert,
  normalizeFleetdUrl,
} from "./fleet-site-routes.js";
import { cleanupTestPki, generateEphemeralTestPki, type TestPkiArtifacts } from "./site-agent-pki.js";
import type { FleetSite, FleetSiteInsert } from "./site-registry.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";

const memberOfA = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_A] };
const memberOfB = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [COMPANY_B] };
const agentActor = { type: "agent", source: "agent_key", agentId: "a", companyId: COMPANY_A, keyId: "k" };

let pki: TestPkiArtifacts;
beforeAll(() => {
  pki = generateEphemeralTestPki();
});
afterAll(() => {
  if (pki) cleanupTestPki(pki);
});

function harness(secrets: string[] = ["fleetd-myr-vm1-token", "fleetd-myr-vm1-client-cert", "fleetd-myr-vm1-client-key"]) {
  const rows: FleetSite[] = [];
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
  const deps = {
    listSites: vi.fn(async (companyId: string) => rows.filter((r) => r.companyId === companyId)),
    getSite: vi.fn(async (companyId: string, name: string) => rows.find((r) => r.companyId === companyId && r.name === name) ?? null),
    createSite,
    deleteSite: vi.fn(async (companyId: string, name: string) => {
      const i = rows.findIndex((r) => r.companyId === companyId && r.name === name);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    }),
    secretExists: vi.fn(async (_companyId: string, name: string) => secrets.includes(name)),
  };
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = who === "b" ? memberOfB : who === "agent" ? agentActor : memberOfA;
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
    caCert: pki.caCert,
    clientCertSecretKey: "fleetd-myr-vm1-client",
    capacity: { maxCpus: 4, maxMemoryMb: 32768, maxBots: 5 },
    gatewayPortStart: 18700,
    gatewayPortEnd: 18759,
    imageAllowlist: ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
    ...overrides,
  };
}

const path = `/companies/${COMPANY_A}/fleet/sites`;

describe("fleet site enroll routes", () => {
  it("enrolls a site: https url, CA fingerprint, secret references, port range, no secret values", async () => {
    const { app, deps } = harness();
    const res = await request(app).post(path).send(body()).expect(201);
    expect(deps.createSite).toHaveBeenCalledTimes(1);
    const input = deps.createSite.mock.calls[0]![0];
    expect(input).toMatchObject({
      companyId: COMPANY_A,
      name: "myr-vm1",
      url: "https://192.0.2.10:9100",
      tokenSecret: "fleetd-myr-vm1-token",
      clientCertSecretKey: "fleetd-myr-vm1-client",
      status: "active",
      capacity: { maxCpus: 4, maxMemoryMb: 32768, maxBots: 5 },
      profile: {
        gatewayPortStart: 18700,
        gatewayPortEnd: 18759,
        imageAllowlist: ["ghcr.io/itkadr-git/myrmidon-hermes@sha256:*"],
      },
    });
    expect(input.caCertFingerprint).toBe(inspectCaCert(pki.caCert).fingerprint);
    expect(res.body.site.name).toBe("myr-vm1");
    expect(JSON.stringify(res.body)).not.toContain("BEGIN");
  });

  it("accepts a single combined secret as the client reference", async () => {
    const { app } = harness(["fleetd-myr-vm1-token", "fleetd-myr-vm1-client"]);
    await request(app).post(path).send(body()).expect(201);
  });

  it("rejects http, paths and credentials in the url", async () => {
    const { app, deps } = harness();
    for (const url of ["http://192.0.2.10:9100", "https://192.0.2.10:9100/v1", "https://u:p@192.0.2.10:9100", "not a url"]) {
      await request(app).post(path).send(body({ url })).expect(400);
    }
    expect(deps.createSite).not.toHaveBeenCalled();
  });

  it("rejects a CA that is not a certificate", async () => {
    const { app } = harness();
    await request(app).post(path).send(body({ caCert: "hello" })).expect(400);
  });

  it("rejects a bad port range and maxBots beyond it", async () => {
    const { app } = harness();
    await request(app).post(path).send(body({ gatewayPortStart: 18760, gatewayPortEnd: 18700 })).expect(400);
    await request(app)
      .post(path)
      .send(body({ gatewayPortStart: 18700, gatewayPortEnd: 18702, capacity: { maxCpus: 1, maxMemoryMb: 1024, maxBots: 5 } }))
      .expect(400);
    await request(app).post(path).send(body({ gatewayPortStart: 80 })).expect(400);
  });

  it("rejects secret references that do not exist, and unknown or reserved fields", async () => {
    const { app, deps } = harness(["fleetd-myr-vm1-token"]);
    await request(app).post(path).send(body()).expect(400);
    const ok = harness();
    await request(ok.app).post(path).send(body({ tokenSecret: "nope" })).expect(400);
    await request(ok.app).post(path).send(body({ name: "local" })).expect(400);
    await request(ok.app).post(path).send(body({ extra: 1 })).expect(400);
    expect(deps.createSite).not.toHaveBeenCalled();
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
    await request(app).get(path).set("x-test-actor", "b").expect(403);
    await request(app).post(path).set("x-test-actor", "b").send(body({ name: "x" })).expect(403);
    await request(app).delete(`${path}/myr-vm1`).set("x-test-actor", "b").expect(403);
    await request(app).get(path).set("x-test-actor", "agent").expect(403);
    await request(app).delete(`${path}/myr-vm1`).expect(200);
    await request(app).delete(`${path}/myr-vm1`).expect(404);
  });
});

describe("fleet site helpers", () => {
  it("normalizes a fleetd url to its origin", () => {
    expect(normalizeFleetdUrl("https://fleetd.internal:9100/")).toBe("https://fleetd.internal:9100");
  });
  it("refuses a client reference with only half of the cert/key pair", async () => {
    const { app, deps } = harness(["fleetd-myr-vm1-token", "fleetd-myr-vm1-client-cert"]);
    await request(app).post(path).send(body()).expect(400);
    expect(deps.createSite).not.toHaveBeenCalled();
  });
});
