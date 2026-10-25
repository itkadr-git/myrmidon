// myrmidon(1.6.6 REMOTE-SITES-T8): the fleet screen's API: overview, site bots, patch, drain/resume,
// restart/stop and logs. The deps are fakes; the route rules are what is under test.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { fleetSiteManageRoutes, type BotCardView, type FleetSiteManageDeps } from "./fleet-site-manage-routes.js";
import type { FleetSite } from "./site-registry.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const BOT = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-25T00:00:00Z");

function board(userId: string, companyId: string, role: string | null) {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: role ? [companyId] : [],
    memberships: role ? [{ companyId, membershipRole: role, status: "active" }] : [],
  };
}
const actors: Record<string, unknown> = {
  admin: board("user-a", COMPANY_A, "admin"),
  member: board("user-m", COMPANY_A, "member"),
  other: board("user-b", COMPANY_B, "admin"),
};

function site(overrides: Partial<FleetSite> = {}): FleetSite {
  return {
    id: "site-1",
    companyId: COMPANY_A,
    name: "myr-vm1",
    url: "https://192.0.2.10:9100",
    status: "active",
    capacity: { maxCpus: 8, maxMemoryMb: 32768, maxBots: 13 },
    profile: { gatewayPortStart: 18700, gatewayPortEnd: 18759 },
    labels: { zone: "a" },
    clientCertNotAfter: new Date(NOW + 30 * 86_400_000),
    lastSeenAt: new Date(NOW - 10_000),
    health: { snapshot: {}, autoDrained: false, state: "healthy", recoveryPasses: 0, reconciled: false, updatedAt: "2026-10-25T00:00:00Z" },
    enrolledAt: new Date("2026-10-20T00:00:00Z"),
    createdAt: new Date("2026-10-20T00:00:00Z"),
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    ...overrides,
  } as FleetSite;
}

function harness(rows: FleetSite[] = [site()], card: BotCardView | null = { companyId: COMPANY_A, host: "myr-vm1" }) {
  const deps = {
    listSites: vi.fn(async (companyId: string) => rows.filter((r) => r.companyId === companyId)),
    getSite: vi.fn(async (companyId: string, name: string) => rows.find((r) => r.companyId === companyId && r.name === name) ?? null),
    updateSite: vi.fn(async (companyId: string, name: string, _patch: unknown) => rows.find((r) => r.companyId === companyId && r.name === name) ?? null),
    setStatus: vi.fn(async (_siteId: string, _from: readonly string[], _to: string) => true),
    markOperatorState: vi.fn(async (_siteId: string) => {}),
    siteLoad: vi.fn(async () => ({ bots: 2, cpus: 2, memoryMb: 2048, driftCount: 1 })),
    listSiteBots: vi.fn(async () => [
      { botKey: BOT, agentName: "work-qa", state: "running", image: "img@sha256:aa", drift: true, driftFields: ["HostConfig.Binds"], apiBaseUrl: "http://192.0.2.20:18701", gatewayPort: 18701, pinned: false },
    ]),
    botCard: vi.fn(async () => card),
    actOnBot: vi.fn(async (_botKey: string, _action: string) => {}),
    botLogs: vi.fn(async (_companyId: string, _site: string, _botKey: string) => "l1\nl2\nl3\nl4\n"),
    readClientCertNotAfter: vi.fn(async (_site: FleetSite): Promise<Date | null> => null),
    storeClientCertNotAfter: vi.fn(async (_site: FleetSite, _notAfter: Date) => {}),
    now: () => NOW,
    log: { warn: vi.fn(), info: vi.fn() },
  } satisfies FleetSiteManageDeps;
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = actors[typeof who === "string" ? who : "admin"];
    next();
  });
  app.use(express.json());
  app.use("/", fleetSiteManageRoutes(deps));
  app.use(errorHandler);
  return { app, deps };
}

const q = `?companyId=${COMPANY_A}`;

describe("fleet site overview", () => {
  it("lists status, lastSeen, capacity used/total, bots, drift and the key TTL, without secrets", async () => {
    const { app } = harness();
    const res = await request(app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    expect(res.body.sites).toHaveLength(1);
    const row = res.body.sites[0];
    expect(row).toMatchObject({
      name: "myr-vm1",
      state: "healthy",
      status: "active",
      certExpired: false,
      botCount: 2,
      driftCount: 1,
      capacity: { cpus: { used: 2, total: 8 }, memoryMb: { used: 2048, total: 32768 }, bots: { used: 2, total: 13 } },
    });
    expect(row.clientCertNotAfter).toBe(new Date(NOW + 30 * 86_400_000).toISOString());
    expect(row.lastSeenAt).toBe(new Date(NOW - 10_000).toISOString());
    expect(JSON.stringify(res.body)).not.toMatch(/BEGIN|tokenSecret|caCert/);
  });

  it("marks an expired key and raises an alert", async () => {
    const { app, deps } = harness([site({ clientCertNotAfter: new Date(NOW - 1000) })]);
    const res = await request(app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    expect(res.body.sites[0].certExpired).toBe(true);
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("logs the expired key once when the state changes, not on every poll", async () => {
    const { app, deps } = harness([site({ clientCertNotAfter: new Date(NOW - 1000) })]);
    for (let i = 0; i < 3; i += 1) await request(app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(409);
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the row when the load cannot be read", async () => {
    const { app, deps } = harness();
    deps.siteLoad.mockRejectedValueOnce(new Error("boom"));
    const res = await request(app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    expect(res.body.sites[0]).toMatchObject({ botCount: 0, driftCount: null });
  });

  it("needs companyId and company access", async () => {
    const { app } = harness();
    await request(app).get("/myrmidon/fleet/sites/overview").expect(400);
    await request(app).get(`/myrmidon/fleet/sites/overview${q}`).set("x-test-actor", "other").expect(403);
    await request(app).get(`/myrmidon/fleet/sites/overview${q}`).set("x-test-actor", "member").expect(200);
  });
});

describe("fleet site bots, patch, drain and resume", () => {
  it("returns the site's bots with drift and gateway address", async () => {
    const { app } = harness();
    const res = await request(app).get(`/myrmidon/fleet/sites/myr-vm1/bots${q}`).expect(200);
    expect(res.body.bots[0]).toMatchObject({ agentName: "work-qa", drift: true, gatewayPort: 18701 });
    await request(app).get(`/myrmidon/fleet/sites/nope/bots${q}`).expect(404);
  });

  it("patches labels and capacity for an admin only, and rejects unknown fields and a bad address", async () => {
    const { app, deps } = harness();
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).send({ labels: { autoResume: "true" }, capacity: { maxCpus: 4, maxMemoryMb: 1024, maxBots: 5 } }).expect(200);
    expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "myr-vm1", { labels: { autoResume: "true" }, capacity: { maxCpus: 4, maxMemoryMb: 1024, maxBots: 5 } });
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).set("x-test-actor", "member").send({ labels: {} }).expect(403);
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).send({ status: "disabled" }).expect(400);
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).send({ url: "http://x:1" }).expect(400);
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).send({}).expect(400);
    await request(app).patch(`/myrmidon/fleet/sites/myr-vm1${q}`).send({ capacity: { maxCpus: 1, maxMemoryMb: 1, maxBots: 61 } }).expect(400);
  });

  it("drains an active site as the operator's drain", async () => {
    const { app, deps } = harness();
    const res = await request(app).post(`/myrmidon/fleet/sites/myr-vm1/drain${q}`).expect(200);
    expect(res.body).toMatchObject({ status: "draining", changed: true });
    expect(deps.setStatus).toHaveBeenCalledWith("site-1", ["active"], "draining");
    expect(deps.markOperatorState).toHaveBeenCalledWith("site-1");
  });

  it("takes over an automatic drain without changing the status", async () => {
    const { app, deps } = harness([site({ status: "draining" })]);
    const res = await request(app).post(`/myrmidon/fleet/sites/myr-vm1/drain${q}`).expect(200);
    expect(res.body.changed).toBe(false);
    expect(deps.setStatus).not.toHaveBeenCalled();
    expect(deps.markOperatorState).toHaveBeenCalled();
  });

  it("refuses to drain a quarantined site and answers 409 when the status moved meanwhile", async () => {
    const quarantined = harness([site({ status: "quarantined" })]);
    await request(quarantined.app).post(`/myrmidon/fleet/sites/myr-vm1/drain${q}`).expect(409);
    const raced = harness();
    raced.deps.setStatus.mockResolvedValueOnce(false);
    await request(raced.app).post(`/myrmidon/fleet/sites/myr-vm1/drain${q}`).expect(409);
  });

  it("resumes a draining site, and refuses when the key has expired or the site is quarantined", async () => {
    const ok = harness([site({ status: "draining" })]);
    const res = await request(ok.app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(200);
    expect(res.body).toMatchObject({ status: "active", changed: true });
    expect(ok.deps.setStatus).toHaveBeenCalledWith("site-1", ["draining"], "active");

    const expired = harness([site({ status: "draining", clientCertNotAfter: new Date(NOW - 1) })]);
    await request(expired.app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(409);
    expect(expired.deps.setStatus).not.toHaveBeenCalled();
    expect(expired.deps.log.warn).toHaveBeenCalled();

    const quarantined = harness([site({ status: "quarantined" })]);
    await request(quarantined.app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(409);

    const already = harness();
    const same = await request(already.app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(200);
    expect(same.body.changed).toBe(false);
  });

  it("lets only a company admin drain and resume", async () => {
    const { app, deps } = harness();
    await request(app).post(`/myrmidon/fleet/sites/myr-vm1/drain${q}`).set("x-test-actor", "member").expect(403);
    await request(app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).set("x-test-actor", "other").expect(403);
    expect(deps.setStatus).not.toHaveBeenCalled();
  });
});

describe("rotating the client certificate", () => {
  it("lifts the block: expired site -> secret rotated -> restart, logs and resume work without editing the site", async () => {
    const { app, deps } = harness([site({ status: "draining", clientCertNotAfter: new Date(NOW - 1000) })]);
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(409);
    await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs`).expect(409);
    await request(app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(409);
    const rotated = new Date(NOW + 30 * 86_400_000);
    deps.readClientCertNotAfter.mockResolvedValue(rotated);
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(200);
    await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs`).expect(200);
    await request(app).post(`/myrmidon/fleet/sites/myr-vm1/resume${q}`).expect(200);
    expect(deps.storeClientCertNotAfter).toHaveBeenCalledWith(expect.objectContaining({ name: "myr-vm1" }), rotated);
    expect(deps.log.info).toHaveBeenCalledTimes(1);
  });

  it("shows the renewed lifetime in the overview, and keeps the stored value when the secret cannot be read", async () => {
    const { app, deps } = harness([site({ clientCertNotAfter: new Date(NOW - 1000) })]);
    deps.readClientCertNotAfter.mockResolvedValueOnce(new Date(NOW + 5 * 86_400_000));
    const ok = await request(app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    expect(ok.body.sites[0]).toMatchObject({ certExpired: false, clientCertNotAfter: new Date(NOW + 5 * 86_400_000).toISOString() });
    const other = harness([site({ clientCertNotAfter: new Date(NOW - 1000) })]);
    other.deps.readClientCertNotAfter.mockRejectedValueOnce(new Error("secret store down"));
    const kept = await request(other.app).get(`/myrmidon/fleet/sites/overview${q}`).expect(200);
    expect(kept.body.sites[0].certExpired).toBe(true);
  });
});

describe("fleet bot restart, stop and logs", () => {
  it("restarts and stops a bot of a remote site for an admin", async () => {
    const { app, deps } = harness();
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(200);
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/stop`).expect(200);
    expect(deps.actOnBot).toHaveBeenNthCalledWith(1, BOT, "restart");
    expect(deps.actOnBot).toHaveBeenNthCalledWith(2, BOT, "stop");
  });

  it("refuses members, other companies, unknown bots and bots on the board host", async () => {
    const { app, deps } = harness();
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).set("x-test-actor", "member").expect(403);
    await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).set("x-test-actor", "other").expect(403);
    expect(deps.actOnBot).not.toHaveBeenCalled();
    const none = harness(undefined, null);
    await request(none.app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(404);
    const local = harness(undefined, { companyId: COMPANY_A, host: null });
    await request(local.app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(409);
  });

  it("refuses to act through a site whose key expired, or that is quarantined or disabled", async () => {
    for (const row of [site({ clientCertNotAfter: new Date(NOW - 1) }), site({ status: "quarantined" }), site({ status: "disabled" })]) {
      const { app, deps } = harness([row]);
      await request(app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(409);
      await request(app).post(`/myrmidon/fleet/bots/${BOT}/stop`).expect(409);
      expect(deps.actOnBot).not.toHaveBeenCalled();
    }
  });

  it("acts on a draining site (its bots are being moved off) and reports a failing site as 502", async () => {
    const draining = harness([site({ status: "draining" })]);
    await request(draining.app).post(`/myrmidon/fleet/bots/${BOT}/stop`).expect(200);
    const failing = harness();
    failing.deps.actOnBot.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const res = await request(failing.app).post(`/myrmidon/fleet/bots/${BOT}/restart`).expect(502);
    expect(JSON.stringify(res.body)).toContain("ECONNREFUSED");
  });

  it("returns the tail of the log, bounded and validated, readable by a member", async () => {
    const { app, deps } = harness();
    const res = await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs?tail=2`).set("x-test-actor", "member").expect(200);
    expect(res.body).toMatchObject({ botKey: BOT, site: "myr-vm1", tail: 2, logs: "l3\nl4" });
    expect(deps.botLogs).toHaveBeenCalledWith(COMPANY_A, "myr-vm1", BOT);
    const all = await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs`).expect(200);
    expect(all.body.logs).toBe("l1\nl2\nl3\nl4");
    for (const tail of ["0", "501", "abc", "1.5"]) {
      await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs?tail=${tail}`).expect(400);
    }
    await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs`).set("x-test-actor", "other").expect(403);
  });

  it("refuses logs through a site whose key expired", async () => {
    const { app, deps } = harness([site({ clientCertNotAfter: new Date(NOW - 1) })]);
    await request(app).get(`/myrmidon/fleet/bots/${BOT}/logs`).expect(409);
    expect(deps.botLogs).not.toHaveBeenCalled();
  });
});
