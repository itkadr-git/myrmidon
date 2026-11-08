// myrmidon(1.6.6 REMOTE-SITES-T5): the move routes check the caller's access to the BOT's company
// (read from the bot's own card), not to a company the request names.
// myrmidon(1.6.7 FLEET-SITE-ENROLL): moving a bot and reading its log are for company admins.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { fleetMoveRoutes } from "./fleet-move-routes.js";
import { FleetMoveError, type FleetMoveRecord } from "./fleet-move-service.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const BOT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function boardActor(userId: string, companyId: string, role: string) {
  return {
    type: "board",
    source: "session",
    userId,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}
const adminOfA = boardActor("user-a", COMPANY_A, "admin");
const ownerOfA = boardActor("user-o", COMPANY_A, "owner");
const memberOfA = boardActor("user-m", COMPANY_A, "member");
const viewerOfA = boardActor("user-v", COMPANY_A, "viewer");
const adminOfB = boardActor("user-b", COMPANY_B, "admin");
const agentActor = { type: "agent", source: "agent_key", agentId: BOT_A, companyId: COMPANY_A, keyId: "key-a" };

function move(overrides: Partial<FleetMoveRecord> = {}): FleetMoveRecord {
  return {
    id: "move-1",
    companyId: COMPANY_A,
    botKey: BOT_A,
    srcSite: "myr-vm1",
    dstSite: "vm-core",
    phase: "done",
    phaseLog: [],
    startedAt: new Date("2026-10-21T08:00:00.000Z"),
    ...overrides,
  };
}

function harness() {
  const getSiteLogs = vi.fn(async (_site: string, _companyId: string, _botKey: string, _tail?: number) => "line-1\nline-2");
  const service = {
    startMove: vi.fn(async (_params: { companyId: string; botKey: string; dstSite: string }) => move()),
    getLatestMove: vi.fn(async (_companyId: string, _botKey: string): Promise<FleetMoveRecord | null> => move()),
  };
  const botCompanyId = vi.fn(async (botKey: string) => (botKey === BOT_A ? COMPANY_A : null));
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    const actors: Record<string, unknown> = { b: adminOfB, agent: agentActor, owner: ownerOfA, member: memberOfA, viewer: viewerOfA };
    (req as unknown as { actor: unknown }).actor = actors[typeof who === "string" ? who : ""] ?? adminOfA;
    next();
  });
  app.use(express.json());
  app.use("/", fleetMoveRoutes({ service, botCompanyId, getSiteLogs }));
  app.use(errorHandler);
  return { app, service, botCompanyId, getSiteLogs };
}

describe("fleet move routes", () => {
  it("moves the bot in ITS company, whatever the body says", async () => {
    const { app, service } = harness();
    await request(app).post(`/fleet/bots/${BOT_A}/move`).send({ to: "vm-core", companyId: COMPANY_B }).expect(200);
    expect(service.startMove).toHaveBeenCalledWith({ companyId: COMPANY_A, botKey: BOT_A, dstSite: "vm-core" });
  });

  it("refuses a member of another company, for move and for status", async () => {
    const { app, service } = harness();
    await request(app).post(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", "b").send({ to: "vm-core" }).expect(403);
    await request(app).get(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", "b").expect(403);
    expect(service.startMove).not.toHaveBeenCalled();
    expect(service.getLatestMove).not.toHaveBeenCalled();
  });

  it("lets a company admin and the owner move a bot and read its status and log", async () => {
    const { app, service, getSiteLogs } = harness();
    for (const who of ["admin", "owner"]) {
      await request(app).post(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", who).send({ to: "vm-core" }).expect(200);
      await request(app).get(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", who).expect(200);
      const logs = await request(app).get(`/fleet/bots/${BOT_A}/logs?site=myr-vm1&tail=5`).set("x-test-actor", who).expect(200);
      expect(logs.text).toBe("line-1\nline-2");
    }
    expect(service.startMove).toHaveBeenCalledTimes(2);
    expect(getSiteLogs).toHaveBeenCalledWith("myr-vm1", COMPANY_A, BOT_A, 5);
  });

  it("refuses a plain company member and a viewer: no move, no status, no log, and the site is not asked", async () => {
    const { app, service, getSiteLogs } = harness();
    for (const who of ["member", "viewer"]) {
      await request(app).post(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", who).send({ to: "vm-core" }).expect(403);
      await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/move`).set("x-test-actor", who).send({ to: "vm-core" }).expect(403);
      await request(app).get(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", who).expect(403);
      await request(app).get(`/fleet/bots/${BOT_A}/logs?site=myr-vm1`).set("x-test-actor", who).expect(403);
      await request(app).get(`/api/myrmidon/fleet/bots/${BOT_A}/logs?site=myr-vm1`).set("x-test-actor", who).expect(403);
    }
    expect(service.startMove).not.toHaveBeenCalled();
    expect(service.getLatestMove).not.toHaveBeenCalled();
    expect(getSiteLogs).not.toHaveBeenCalled();
  });

  it("refuses an agent key", async () => {
    const { app } = harness();
    await request(app).post(`/fleet/bots/${BOT_A}/move`).set("x-test-actor", "agent").send({ to: "vm-core" }).expect(403);
  });

  it("answers 404 for an unknown bot instead of using a made-up company", async () => {
    const { app, service } = harness();
    await request(app).post("/fleet/bots/unknown-bot/move").send({ to: "vm-core" }).expect(404);
    await request(app).get("/fleet/bots/unknown-bot/move").expect(404);
    expect(service.startMove).not.toHaveBeenCalled();
  });

  it("maps move errors the caller can act on, and reports a failed move as 500 with its log", async () => {
    const { app, service } = harness();
    service.startMove.mockRejectedValueOnce(new FleetMoveError("already there", "conflict"));
    await request(app).post(`/fleet/bots/${BOT_A}/move`).send({ to: "vm-core" }).expect(409);

    service.startMove.mockResolvedValueOnce(move({ phase: "failed", error: "restore refused" }));
    const res = await request(app).post(`/fleet/bots/${BOT_A}/move`).send({ to: "vm-core" }).expect(500);
    expect(res.body.move.error).toBe("restore refused");
  });

  it("requires a target site", async () => {
    const { app } = harness();
    await request(app).post(`/fleet/bots/${BOT_A}/move`).send({}).expect(400);
  });

  it("status of a bot without moves is 404", async () => {
    const { app, service } = harness();
    service.getLatestMove.mockResolvedValueOnce(null);
    await request(app).get(`/fleet/bots/${BOT_A}/move`).expect(404);
  });

  it("answers 409 with the explanation when the bot already has an unfinished move", async () => {
    const { app, service } = harness();
    const text = 'Bot "x" already has an unfinished move (move m1 from "a" to "b", phase "restore"); wait for it to finish, or repeat the request with the same destination to resume it';
    service.startMove.mockRejectedValueOnce(new FleetMoveError(text, "conflict"));
    const res = await request(app).post(`/fleet/bots/${BOT_A}/move`).send({ to: "vm-core" }).expect(409);
    expect(JSON.stringify(res.body)).toContain("already has an unfinished move");
    expect(JSON.stringify(res.body)).toContain("wait for it to finish");
  });
});
