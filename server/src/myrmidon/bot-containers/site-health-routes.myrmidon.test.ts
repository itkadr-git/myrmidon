import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { siteBadge, siteHealthRoutes } from "./site-health-routes.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const memberOfA = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_A] };
const memberOfB = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [COMPANY_B] };

const row = (over: Record<string, unknown> = {}) => ({
  name: "myr-vm1",
  status: "active",
  lastSeenAt: new Date("2026-10-23T08:00:00.000Z"),
  health: { state: "healthy", autoDrained: false },
  ...over,
}) as Parameters<typeof siteBadge>[0];

describe("siteBadge", () => {
  it("shows the probe state of an active site", () => {
    expect(siteBadge(row())).toEqual({
      name: "myr-vm1", state: "healthy", status: "active", autoDrained: false, lastSeenAt: "2026-10-23T08:00:00.000Z",
    });
    expect(siteBadge(row({ health: { state: "degraded" } })).state).toBe("degraded");
  });

  it("a site never probed is unknown and has no last-seen time", () => {
    expect(siteBadge(row({ health: null, lastSeenAt: null }))).toMatchObject({ state: "unknown", lastSeenAt: null });
  });

  it("an unreachable site that was drained keeps showing unreachable and says who drained it", () => {
    expect(siteBadge(row({ status: "draining", health: { state: "unreachable", autoDrained: true } }))).toMatchObject({
      state: "unreachable", status: "draining", autoDrained: true,
    });
  });

  it("a drain whose site answers shows draining; the registry status wins for quarantined", () => {
    expect(siteBadge(row({ status: "draining", health: { state: "healthy" } })).state).toBe("draining");
    expect(siteBadge(row({ status: "quarantined", health: { state: "healthy" } })).state).toBe("quarantined");
  });

  it("an unknown probe state does not leak into the badge", () => {
    expect(siteBadge(row({ health: { state: "weird" } })).state).toBe("unknown");
  });
});

describe("GET /myrmidon/fleet/sites", () => {
  function app(rows: unknown[]) {
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
    const a = express();
    a.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = req.headers["x-test-actor"] === "b" ? memberOfB : memberOfA;
      next();
    });
    a.use("/", siteHealthRoutes(db));
    a.use(errorHandler);
    return a;
  }

  it("lists the badges of the company sorted by name", async () => {
    const res = await request(app([row({ name: "b" }), row({ name: "a", status: "draining", health: { state: "unreachable", autoDrained: true } })]))
      .get(`/myrmidon/fleet/sites?companyId=${COMPANY_A}`)
      .expect(200);
    expect(res.body.sites.map((s: { name: string; state: string }) => `${s.name}:${s.state}`)).toEqual(["a:unreachable", "b:healthy"]);
  });

  it("needs a company and refuses a member of another one", async () => {
    await request(app([])).get("/myrmidon/fleet/sites").expect(400);
    await request(app([])).get(`/myrmidon/fleet/sites?companyId=${COMPANY_A}`).set("x-test-actor", "b").expect(403);
  });
});
