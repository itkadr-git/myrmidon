// myrmidon(fleet-site audit): the site network profile is taken for a private address only.
//
// PATCH /myrmidon/fleet/sites/:name accepts privateNetwork / tunnel (they open plain http to the
// site's bot gateways) only when the site address is a private IP address, keeps a flagged site on
// a private address, and edits the gateway port range the adapter checks the plain-http port against.
// The deps are fakes; the route rules are what is under test.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import {
  assertPrivateAddressRules,
  fleetSiteManageRoutes,
  type FleetSiteManageDeps,
  type SitePatchBody,
} from "./fleet-site-manage-routes.js";
import type { FleetSite, FleetSiteUpdate } from "./site-registry.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-01T00:00:00Z");

const actors: Record<string, unknown> = {
  // an owner passes the company-admin check and a stricter owner-only check alike
  owner: {
    type: "board",
    source: "session",
    userId: "user-o",
    isInstanceAdmin: false,
    companyIds: [COMPANY_A],
    memberships: [{ companyId: COMPANY_A, membershipRole: "owner", status: "active" }],
  },
  member: {
    type: "board",
    source: "session",
    userId: "user-m",
    isInstanceAdmin: false,
    companyIds: [COMPANY_A],
    memberships: [{ companyId: COMPANY_A, membershipRole: "member", status: "active" }],
  },
};

function site(overrides: Partial<FleetSite> = {}): FleetSite {
  return {
    id: "site-1",
    companyId: COMPANY_A,
    name: "site-a",
    url: "https://192.0.2.10:9100",
    status: "active",
    capacity: { maxCpus: 8, maxMemoryMb: 32768, maxBots: 13 },
    profile: { gatewayPortStart: 18700, gatewayPortEnd: 18759 },
    labels: {},
    clientCertNotAfter: new Date(NOW + 30 * 86_400_000),
    enrolledAt: new Date("2026-10-20T00:00:00Z"),
    createdAt: new Date("2026-10-20T00:00:00Z"),
    updatedAt: new Date("2026-10-20T00:00:00Z"),
    ...overrides,
  } as FleetSite;
}

function harness(row: FleetSite = site()) {
  const deps = {
    listSites: vi.fn(async () => [row]),
    getSite: vi.fn(async (companyId: string, name: string) => (row.companyId === companyId && row.name === name ? row : null)),
    updateSite: vi.fn(async (_companyId: string, _name: string, _patch: unknown) => row),
    setStatus: vi.fn(async () => true),
    markOperatorState: vi.fn(async () => {}),
    siteLoad: vi.fn(async () => ({ bots: 0, cpus: 0, memoryMb: 0, driftCount: 0 })),
    listSiteBots: vi.fn(async () => []),
    botCard: vi.fn(async () => null),
    actOnBot: vi.fn(async () => {}),
    botLogs: vi.fn(async () => ""),
    now: () => NOW,
    log: { warn: vi.fn(), info: vi.fn() },
  } satisfies FleetSiteManageDeps;
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = actors[typeof who === "string" ? who : "owner"];
    next();
  });
  app.use(express.json());
  app.use("/", fleetSiteManageRoutes(deps));
  app.use(errorHandler);
  return { app, deps };
}

const url = `/myrmidon/fleet/sites/site-a?companyId=${COMPANY_A}`;

describe("privateNetwork / tunnel need a private address of the site", () => {
  it("refuses privateNetwork:true for a public address, a TEST-NET address, a link-local address and a DNS name", async () => {
    for (const address of ["https://8.8.8.8:9100", "https://192.0.2.10:9100", "https://169.254.1.1:9100", "https://fleetd.example.test:9100"]) {
      const { app, deps } = harness(site({ url: address }));
      const res = await request(app).patch(url).send({ privateNetwork: true }).expect(400);
      expect(JSON.stringify(res.body)).toMatch(/privateNetwork: the site address is not a private IP address/);
      expect(deps.updateSite).not.toHaveBeenCalled();
    }
  });

  it("refuses tunnel:true the same way", async () => {
    const { app, deps } = harness(site({ url: "https://8.8.8.8:9100" }));
    const res = await request(app).patch(url).send({ tunnel: true }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/tunnel: the site address is not a private IP address/);
    expect(deps.updateSite).not.toHaveBeenCalled();
  });

  it("accepts the flags for RFC 1918, 100.64/10 and loopback addresses", async () => {
    for (const host of ["10.0.0.10", "172.16.4.4", "172.31.0.1", "192.168.1.9", "100.64.0.5", "100.127.9.9", "127.0.0.1"]) {
      const { app, deps } = harness(site({ url: `https://${host}:9100` }));
      await request(app).patch(url).send({ privateNetwork: true, tunnel: true }).expect(200);
      expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "site-a", {
        profile: { gatewayPortStart: 18700, gatewayPortEnd: 18759, privateNetwork: true, tunnel: true },
      });
    }
  });

  it("reads the host the way a URL parser does", async () => {
    // 10.1 is 10.0.0.1; 010.0.0.1 is 8.0.0.1 (octal) and a public address
    const near = harness(site({ url: "https://10.1:9100" }));
    await request(near.app).patch(url).send({ privateNetwork: true }).expect(200);
    const octal = harness(site({ url: "https://010.0.0.1:9100" }));
    await request(octal.app).patch(url).send({ privateNetwork: true }).expect(400);
  });

  it("looks at the address after the same patch: a new private url and the flag together pass, a public one does not", async () => {
    const start = harness(site({ url: "https://8.8.8.8:9100" }));
    await request(start.app).patch(url).send({ url: "https://10.0.0.10:9100", privateNetwork: true }).expect(200);
    expect(start.deps.updateSite).toHaveBeenCalledWith(
      COMPANY_A,
      "site-a",
      expect.objectContaining({ url: "https://10.0.0.10:9100", profile: expect.objectContaining({ privateNetwork: true }) }),
    );
    const other = harness(site({ url: "https://10.0.0.10:9100" }));
    await request(other.app).patch(url).send({ url: "https://8.8.8.8:9100", privateNetwork: true }).expect(400);
    expect(other.deps.updateSite).not.toHaveBeenCalled();
  });

  it("clearing a flag is always allowed, and so is a patch that does not touch the address or the flags", async () => {
    const legacy = harness(site({ url: "https://192.0.2.10:9100", profile: { privateNetwork: true, gatewayPortStart: 18700, gatewayPortEnd: 18759 } }));
    await request(legacy.app).patch(url).send({ privateNetwork: false }).expect(200);
    await request(legacy.app).patch(url).send({ labels: { zone: "b" } }).expect(200);
    await request(legacy.app).patch(url).send({ capacity: { maxCpus: 2, maxMemoryMb: 1024, maxBots: 3 } }).expect(200);
    expect(legacy.deps.updateSite).toHaveBeenCalledTimes(3);
  });

  it("a site that carries a flag is not moved to a public address by a patch", async () => {
    const flagged = (extra: Partial<FleetSite["profile"]> = {}) =>
      harness(site({ url: "https://10.0.0.10:9100", profile: { privateNetwork: true, gatewayPortStart: 18700, gatewayPortEnd: 18759, ...extra } }));

    const blocked = flagged();
    const res = await request(blocked.app).patch(url).send({ url: "https://8.8.8.8:9100" }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/url: /);
    expect(blocked.deps.updateSite).not.toHaveBeenCalled();

    const tunnelOnly = flagged({ privateNetwork: false, tunnel: true });
    await request(tunnelOnly.app).patch(url).send({ url: "https://8.8.8.8:9100" }).expect(400);

    const stillTunnel = flagged({ privateNetwork: true, tunnel: true });
    await request(stillTunnel.app).patch(url).send({ url: "https://8.8.8.8:9100", privateNetwork: false }).expect(400);

    const moved = flagged();
    await request(moved.app).patch(url).send({ url: "https://10.0.0.11:9100" }).expect(200);
  });

  // The rule itself, without the route in front of it: another rule of the route (the host rule of a
  // changed address) may refuse a public address first, but this one holds on its own.
  describe("assertPrivateAddressRules", () => {
    const flaggedSite = (profile: FleetSite["profile"]) => site({ url: "https://10.0.0.10:9100", profile });
    const check = (row: FleetSite, body: SitePatchBody, patch: FleetSiteUpdate) => () => assertPrivateAddressRules(row, body, patch);

    it("holds a flagged site on a private address when the address changes", () => {
      const row = flaggedSite({ privateNetwork: true });
      expect(check(row, { url: "https://8.8.8.8:9100" }, { url: "https://8.8.8.8:9100" })).toThrow(/site is marked private/);
      const tunnel = flaggedSite({ tunnel: true });
      expect(check(tunnel, { url: "https://8.8.8.8:9100" }, { url: "https://8.8.8.8:9100" })).toThrow(/site is marked private/);
      // one flag cleared, the other still set
      const both = flaggedSite({ privateNetwork: true, tunnel: true });
      expect(check(both, { url: "https://8.8.8.8:9100", privateNetwork: false }, { url: "https://8.8.8.8:9100", profile: { ...both.profile, privateNetwork: false } })).toThrow(
        /site is marked private/,
      );
    });

    it("lets the address change when both flags are cleared in the same request, or when the new address is private", () => {
      const both = flaggedSite({ privateNetwork: true, tunnel: true });
      const cleared = { ...both.profile, privateNetwork: false, tunnel: false };
      expect(check(both, { url: "https://8.8.8.8:9100", privateNetwork: false, tunnel: false }, { url: "https://8.8.8.8:9100", profile: cleared })).not.toThrow();
      expect(check(both, { url: "https://10.0.0.11:9100" }, { url: "https://10.0.0.11:9100" })).not.toThrow();
    });

    it("does not look at a site that is not marked, or at a request that leaves the address and the flags alone", () => {
      const plain = site({ url: "https://8.8.8.8:9100", profile: {} });
      expect(check(plain, { url: "https://1.1.1.1:9100" }, { url: "https://1.1.1.1:9100" })).not.toThrow();
      const legacy = site({ url: "https://8.8.8.8:9100", profile: { privateNetwork: true } });
      expect(check(legacy, { labels: { a: "b" } }, { labels: { a: "b" } })).not.toThrow();
      expect(check(legacy, { privateNetwork: false }, { profile: { privateNetwork: false } })).not.toThrow();
    });

    it("refuses to mark a site that is not on a private address", () => {
      const row = site({ url: "https://8.8.8.8:9100", profile: {} });
      expect(check(row, { privateNetwork: true }, { profile: { privateNetwork: true } })).toThrow(/privateNetwork: the site address is not a private IP address/);
      expect(check(row, { tunnel: true }, { profile: { tunnel: true } })).toThrow(/tunnel: the site address is not a private IP address/);
      expect(check(row, { privateNetwork: true, url: "https://10.0.0.7:9100" }, { url: "https://10.0.0.7:9100", profile: { privateNetwork: true } })).not.toThrow();
    });
  });

  it("is refused to a plain company member", async () => {
    const { app, deps } = harness(site({ url: "https://10.0.0.10:9100" }));
    await request(app).patch(url).set("x-test-actor", "member").send({ privateNetwork: true }).expect(403);
    expect(deps.updateSite).not.toHaveBeenCalled();
  });
});

describe("the gateway port range of the site record", () => {
  it("sets both ends and keeps the rest of the profile", async () => {
    const { app, deps } = harness(site({ url: "https://10.0.0.10:9100", profile: { privateNetwork: true, volumeRoot: "/srv/bots" } }));
    await request(app).patch(url).send({ gatewayPortStart: 18700, gatewayPortEnd: 18799 }).expect(200);
    expect(deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "site-a", {
      profile: { privateNetwork: true, volumeRoot: "/srv/bots", gatewayPortStart: 18700, gatewayPortEnd: 18799 },
    });
  });

  it("completes one end from the stored range, and needs both ends when nothing is stored", async () => {
    const stored = harness(site());
    await request(stored.app).patch(url).send({ gatewayPortEnd: 18780 }).expect(200);
    expect(stored.deps.updateSite).toHaveBeenCalledWith(COMPANY_A, "site-a", {
      profile: { gatewayPortStart: 18700, gatewayPortEnd: 18780 },
    });

    const empty = harness(site({ profile: {} }));
    const res = await request(empty.app).patch(url).send({ gatewayPortEnd: 18780 }).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/send both ends/);
    expect(empty.deps.updateSite).not.toHaveBeenCalled();
  });

  it("refuses a reversed range, a port below 1024 and a range the capacity does not fit", async () => {
    const { app, deps } = harness(site({ capacity: { maxCpus: 8, maxMemoryMb: 32768, maxBots: 13 } }));
    await request(app).patch(url).send({ gatewayPortStart: 18799, gatewayPortEnd: 18700 }).expect(400);
    await request(app).patch(url).send({ gatewayPortStart: 80, gatewayPortEnd: 18700 }).expect(400);
    await request(app).patch(url).send({ gatewayPortStart: 18700, gatewayPortEnd: 70000 }).expect(400);
    await request(app).patch(url).send({ gatewayPortStart: 18700, gatewayPortEnd: 18705 }).expect(400); // 6 ports, maxBots 13
    await request(app).patch(url).send({ gatewayPortStart: 18700.5, gatewayPortEnd: 18705 }).expect(400);
    expect(deps.updateSite).not.toHaveBeenCalled();
  });

  it("checks maxBots against the range sent in the same request", async () => {
    const { app, deps } = harness();
    await request(app)
      .patch(url)
      .send({ gatewayPortStart: 18700, gatewayPortEnd: 18705, capacity: { maxCpus: 1, maxMemoryMb: 1, maxBots: 6 } })
      .expect(200);
    await request(app)
      .patch(url)
      .send({ gatewayPortStart: 18700, gatewayPortEnd: 18705, capacity: { maxCpus: 1, maxMemoryMb: 1, maxBots: 7 } })
      .expect(400);
    expect(deps.updateSite).toHaveBeenCalledTimes(1);
  });
});
