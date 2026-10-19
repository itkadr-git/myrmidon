import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { fleetSiteRoutes } from "./routes.js";
import type { FleetSiteStore } from "./store.js";
import type { FleetSiteInput, FleetSiteView } from "./domain.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SITE_ID = "44444444-4444-4444-8444-444444444444";
const OWNER = {
  type: "board",
  source: "session",
  userId: "owner",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
  memberships: [{ companyId: COMPANY_ID, status: "active", membershipRole: "owner" }],
};

function site(overrides: Partial<FleetSiteView> = {}): FleetSiteView {
  return {
    id: SITE_ID,
    slug: "myr-vm1",
    fleetdUrl: "https://fleetd.example.test:8444",
    label: "VM 1",
    siteCaFingerprint: null,
    region: "test",
    capacityCpu: 6,
    capacityRamGb: 24,
    maxBots: null,
    maxRunTokensMin: null,
    status: "enabled",
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...overrides,
  };
}

function app(store: FleetSiteStore) {
  const api = express();
  api.use(express.json());
  api.use((req, _res, next) => {
    req.actor = OWNER as never;
    next();
  });
  api.use(fleetSiteRoutes({ store }));
  api.use(errorHandler);
  return api;
}

function memoryStore(): FleetSiteStore {
  const rows = new Map<string, FleetSiteView>();
  return {
    async list(companyId) {
      return [...rows.values()].filter(() => companyId === COMPANY_ID);
    },
    async create(input: FleetSiteInput) {
      const row = site({ ...input, id: SITE_ID, createdAt: site().createdAt, updatedAt: site().updatedAt });
      rows.set(row.slug, row);
      return row;
    },
    async patch(companyId, slug, status) {
      if (companyId !== COMPANY_ID) return null;
      const row = rows.get(slug);
      if (!row) return null;
      const updated = { ...row, status, updatedAt: "2026-10-19T00:01:00.000Z" };
      rows.set(slug, updated);
      return updated;
    },
  };
}

const input = {
  companyId: COMPANY_ID,
  slug: "myr-vm1",
  fleetdUrl: "https://fleetd.example.test:8444",
  label: "VM 1",
  region: "test",
  capacityCpu: 6,
  capacityRamGb: 24,
};

describe("fleet-site registry routes", () => {
  it("supports 200 create, list, and operator status patch", async () => {
    const response = await request(app(memoryStore())).post("/myrmidon/fleet/sites").send(input);
    expect(response.status).toBe(200);
    expect(response.body.site.slug).toBe("myr-vm1");

    const listed = await request(app({
      ...memoryStore(),
      list: async () => [response.body.site],
    })).get(`/myrmidon/fleet/sites?companyId=${COMPANY_ID}`);
    expect(listed.status).toBe(200);
    expect(listed.body.sites).toHaveLength(1);

    const store = memoryStore();
    await store.create(input);
    const patched = await request(app(store)).patch("/myrmidon/fleet/sites").send({ companyId: COMPANY_ID, slug: "myr-vm1", status: "draining" });
    expect(patched.status).toBe(200);
    expect(patched.body.site.status).toBe("draining");
  });

  it("rejects invalid site contracts", async () => {
    const response = await request(app(memoryStore())).post("/myrmidon/fleet/sites").send({ ...input, capacityCpu: 0 });
    expect(response.status).toBe(400);
  });
});
