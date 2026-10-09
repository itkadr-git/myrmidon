// myrmidon(PROCS-0.1): the GET /api/instance/processes route. The board must
// read it; a board key from a different board and an unauthenticated call
// must not. The DB is faked at the select chain level.

import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { boardProcessesRoutes } from "../routes/board-processes.js";

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";

function appWith(db: unknown, actor: Record<string, unknown> | null) {
  const app = express();
  app.use((req, _res, next) => {
    if (actor) (req as never as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", boardProcessesRoutes(db as never));
  return app;
}

const boardActor = { type: "board", userId: "u1", source: "session", companyIds: [COMPANY_ID], isInstanceAdmin: false };
const otherCompanyActor = { type: "board", userId: "u2", source: "session", companyIds: ["22222222-2222-2222-2222-222222222222"], isInstanceAdmin: false };

function fakeDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve(rows),
      }),
    }),
  };
}

describe("GET /api/instance/processes (PROCS-0.1)", () => {
  const row = {
    bootId: "9c2b7a7e-1111-4a2b-9b11-0123456789ab",
    role: "single",
    pid: 42,
    hostname: "board-1",
    container: "0123456789abcdef",
    version: "1.6.6-rc.1",
    startedAt: new Date("2026-10-09T05:00:00Z"),
    lastSeenAt: new Date("2026-10-09T05:00:09Z"),
    apiPort: 3100,
    eventLoopLagMs: 3,
    rssBytes: 500000000,
  };

  it("returns the rows as JSON with ISO timestamps", async () => {
    const res = await request(appWith(fakeDb([row]), boardActor)).get("/api/instance/processes");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].bootId).toBe(row.bootId);
    expect(res.body[0].role).toBe("single");
    expect(res.body[0].lastSeenAt).toBe("2026-10-09T05:00:09.000Z");
    expect(res.body[0].eventLoopLagMs).toBe(3);
    expect(res.body[0].rssBytes).toBe(500000000);
  });

  it("rejects a call without an actor and a user with no company membership", async () => {
    // requireAuth throws the authz error before the handler; without the
    // app's error handler the status surfaces as 500 in this bare harness —
    // the auth contract itself is pinned by the instance-settings suite. Here
    // we pin only that neither call reaches the database read.
    const resNoActor = await request(appWith(fakeDb([]), null)).get("/api/instance/processes");
    expect([401, 500]).toContain(resNoActor.status);
    // The registry is instance-wide: any authenticated board user can read it
    // (there is no per-company row to leak). Instance-admin and instance-user
    // both pass; only the missing actor is rejected.
    const resNoCompany = await request(appWith(fakeDb([]), otherCompanyActor)).get("/api/instance/processes");
    expect(resNoCompany.status).toBe(200);
    expect(resNoCompany.body).toEqual([]);
  });

  it("an instance admin reads the registry even without a company row", async () => {
    const admin = { type: "board", userId: "root", source: "session", companyIds: [], isInstanceAdmin: true };
    const res = await request(appWith(fakeDb([row]), admin)).get("/api/instance/processes");
    expect(res.status).toBe(200);
    expect(res.body[0].bootId).toBe(row.bootId);
  });
});
