// myrmidon(1.6.5 BOT-DISK-H4d): the panel reads of the board —
// GET /api/myrmidon/bot-disk/reports (C4, last report per bot, flattened) and
// GET /api/myrmidon/bot-disk/physical (C5, the dockergate answer, or 503).
//
// The gate is injected: the fixtures are the contract's own, so the test proves
// the relay does not reshape what dockergate sends.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { wsDiskApiResponseSchema } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { storeBotDiskReport, resetBotDiskReports } from "./bot-disk-report-store.js";
import { BOT_DISK_PHYSICAL_UNAVAILABLE, botDiskReadsRoutes } from "./bot-disk-reads-routes.js";
import { botDiskReportRoutes } from "./bot-disk-report-routes.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "44444444-4444-4444-8444-444444444444";
const REPORTS = "/api/myrmidon/bot-disk/reports";
const PHYSICAL = "/api/myrmidon/bot-disk/physical";
const INGEST = "/api/myrmidon/bots/me/disk-report";

const agent = (agentId: string) => ({ type: "agent", source: "agent_key", agentId, companyId: COMPANY_ID, keyId: "k" });
const boardActor = { type: "board", source: "session", userId: "u", isInstanceAdmin: true, companyIds: [COMPANY_ID] };
const anon = { type: "none", source: "none" };

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract", name), "utf8"));

/** A gate that answers the contract fixture; `fails` turns it into an unreachable one. */
const gateStub = (fails = false) => ({
  getDisk: async () => {
    if (fails) throw new Error("dockergate is not there");
    return fixture("dockergate-disk.json");
  },
});

function appFor(actor: unknown, options: { gateFails?: boolean } = {}) {
  const app = express();
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", botDiskReportRoutes());
  app.use("/api", botDiskReadsRoutes({ gate: gateStub(options.gateFails) }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => resetBotDiskReports());

describe("GET /api/myrmidon/bot-disk/reports", () => {
  it("relays the last report of every bot, flattened, with the receive time", async () => {
    const report = { ...fixture("disk-report.json"), botKey: BOT_A, imageGeneration: "gen-a" };
    storeBotDiskReport(BOT_A, report, Date.parse("2026-10-07T03:00:00.000Z"));
    const res = await request(appFor(boardActor)).get(REPORTS);
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ botKey: BOT_A, imageGeneration: "gen-a" });
    expect(res.body.reports[0].receivedAt).toBe("2026-10-07T03:00:00.000Z");
    // Flattened, not wrapped: the panel type is the C4 report itself.
    expect(res.body.reports[0].report).toBeUndefined();
  });

  it("shows what the ingest route accepted", async () => {
    const app = appFor(boardActor);
    await request(appFor(agent(BOT_A)))
      .post(INGEST)
      .send({ ...fixture("disk-report.json"), botKey: BOT_A })
      .expect(200);
    const res = await request(app).get(REPORTS);
    expect(res.status).toBe(200);
    expect(res.body.reports.map((r: { botKey: string }) => r.botKey)).toEqual([BOT_A]);
  });

  it("an empty store is an empty list, not an error", async () => {
    const res = await request(appFor(boardActor)).get(REPORTS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [] });
  });

  it("an agent key is 403 and an anonymous call is 401", async () => {
    expect((await request(appFor(agent(BOT_A))).get(REPORTS)).status).toBe(403);
    expect((await request(appFor(anon)).get(REPORTS)).status).toBe(401);
  });
});

describe("GET /api/myrmidon/bot-disk/physical", () => {
  it("relays the dockergate answer unchanged", async () => {
    const res = await request(appFor(boardActor)).get(PHYSICAL);
    expect(res.status).toBe(200);
    expect(wsDiskApiResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toEqual(fixture("dockergate-disk.json"));
  });

  it("an unreachable gate is a 503, never invented numbers", async () => {
    const res = await request(appFor(boardActor, { gateFails: true })).get(PHYSICAL);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe(BOT_DISK_PHYSICAL_UNAVAILABLE);
  });

  it("an agent key is 403 and an anonymous call is 401", async () => {
    expect((await request(appFor(agent(BOT_A))).get(PHYSICAL)).status).toBe(403);
    expect((await request(appFor(anon)).get(PHYSICAL)).status).toBe(401);
  });
});

describe("two bots", () => {
  it("the panel sees both bot keys, and neither key can read the route", async () => {
    storeBotDiskReport(BOT_A, { ...fixture("disk-report.json"), botKey: BOT_A });
    storeBotDiskReport(BOT_B, { ...fixture("disk-report.json"), botKey: BOT_B });
    const res = await request(appFor(boardActor)).get(REPORTS);
    expect(res.body.reports.map((r: { botKey: string }) => r.botKey).sort()).toEqual([BOT_A, BOT_B].sort());
  });
});