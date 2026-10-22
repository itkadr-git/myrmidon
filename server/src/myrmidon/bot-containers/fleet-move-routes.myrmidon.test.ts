// myrmidon(1.6.6 REMOTE-SITES-T5): the move routes check the caller's access to the BOT's company
// (read from the bot's own card), not to a company the request names.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { fleetMoveRoutes } from "./fleet-move-routes.js";
import { FleetMoveError, type FleetMoveRecord } from "./fleet-move-service.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const BOT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const memberOfA = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_A] };
const memberOfB = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [COMPANY_B] };
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
  const service = {
    startMove: vi.fn(async (_params: { companyId: string; botKey: string; dstSite: string }) => move()),
    getLatestMove: vi.fn(async (_companyId: string, _botKey: string): Promise<FleetMoveRecord | null> => move()),
  };
  const botCompanyId = vi.fn(async (botKey: string) => (botKey === BOT_A ? COMPANY_A : null));
  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = who === "b" ? memberOfB : who === "agent" ? agentActor : memberOfA;
    next();
  });
  app.use(express.json());
  app.use("/", fleetMoveRoutes({ service, botCompanyId }));
  app.use(errorHandler);
  return { app, service, botCompanyId };
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
});
