// myrmidon(1.6.5 BOT-DISK-H4b): POST /api/myrmidon/bots/me/disk-report (contract C4).
//
// The route runs with the same body parser setup as the app (a 10 MB JSON parser
// that keeps the raw bytes), so the 1 MiB cap is exercised on a body the parser
// has already accepted. Fixtures are the contract's own.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  WS_DISK_REPORT_MAX_ACTIONS,
  WS_DISK_REPORT_MAX_BODY_BYTES,
  wsDiskReportResponseSchema,
  wsDiskReportSchema,
} from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { BOT_DISK_NEXT_REPORT_SEC, botDiskReportRoutes } from "./bot-disk-report-routes.js";
import { readBotDiskReport, readBotDiskReports, resetBotDiskReports } from "./bot-disk-report-store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_A = "11111111-1111-4111-8111-111111111111";
const BOT_B = "44444444-4444-4444-8444-444444444444";
const URL = "/api/myrmidon/bots/me/disk-report";

const agent = (agentId: string) => ({ type: "agent", source: "agent_key", agentId, companyId: COMPANY_ID, keyId: "k" });
const boardActor = { type: "board", source: "session", userId: "u", isInstanceAdmin: true, companyIds: [COMPANY_ID] };

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract", name), "utf8"));

/** The contract fixture, with the bot key of the calling agent. */
const reportFor = (botKey: string, over: Record<string, unknown> = {}) => ({
  ...fixture("disk-report.json"),
  botKey,
  ...over,
});

function appFor(actor: unknown) {
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
  app.use(errorHandler);
  return app;
}

beforeEach(() => resetBotDiskReports());

describe("contract fixtures", () => {
  it("the report fixture passes the schema and the response fixture is what the route sends", async () => {
    expect(wsDiskReportSchema.safeParse(fixture("disk-report.json")).success).toBe(true);
    expect(wsDiskReportResponseSchema.safeParse(fixture("disk-report-response.json")).success).toBe(true);
    const res = await request(appFor(agent(BOT_A))).post(URL).send(reportFor(BOT_A));
    expect(res.status).toBe(200);
    expect(wsDiskReportResponseSchema.parse(res.body)).toEqual({ ok: true, nextReportSec: BOT_DISK_NEXT_REPORT_SEC });
  });
});

describe("POST disk-report", () => {
  it("accepts a valid report and readBotDiskReports returns it", async () => {
    const res = await request(appFor(agent(BOT_A))).post(URL).send(reportFor(BOT_A));
    expect(res.status).toBe(200);
    const stored = readBotDiskReports();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.botKey).toBe(BOT_A);
    expect(stored[0]!.report).toEqual(reportFor(BOT_A));
    expect(Number.isNaN(Date.parse(stored[0]!.receivedAt))).toBe(false);
  });

  it("a newer report replaces the older one", async () => {
    const app = appFor(agent(BOT_A));
    await request(app).post(URL).send(reportFor(BOT_A, { imageGeneration: "first" })).expect(200);
    await request(app).post(URL).send(reportFor(BOT_A, { imageGeneration: "second" })).expect(200);
    expect(readBotDiskReports()).toHaveLength(1);
    expect(readBotDiskReport(BOT_A)!.report.imageGeneration).toBe("second");
  });

  it("a broken schema is 400 and does not overwrite the previous report", async () => {
    const app = appFor(agent(BOT_A));
    await request(app).post(URL).send(reportFor(BOT_A, { imageGeneration: "good" })).expect(200);
    const bad = await request(app).post(URL).send(reportFor(BOT_A, { schema: 2, imageGeneration: "bad" }));
    expect(bad.status).toBe(400);
    const noCopies = { ...reportFor(BOT_A, { imageGeneration: "bad" }) } as Record<string, unknown>;
    delete noCopies.copies;
    expect((await request(app).post(URL).send(noCopies)).status).toBe(400);
    expect(readBotDiskReport(BOT_A)!.report.imageGeneration).toBe("good");
  });

  it("more than the allowed number of actions is 400", async () => {
    const action = fixture("disk-report.json").actions[0];
    const actions = Array.from({ length: WS_DISK_REPORT_MAX_ACTIONS + 1 }, () => action);
    const res = await request(appFor(agent(BOT_A))).post(URL).send(reportFor(BOT_A, { actions }));
    expect(res.status).toBe(400);
    expect(readBotDiskReports()).toHaveLength(0);
  });

  it("a body over the cap is 413 and nothing is stored", async () => {
    const app = appFor(agent(BOT_A));
    await request(app).post(URL).send(reportFor(BOT_A, { imageGeneration: "good" })).expect(200);
    const pad = "x".repeat(WS_DISK_REPORT_MAX_BODY_BYTES + 1);
    const res = await request(app).post(URL).send(reportFor(BOT_A, { imageGeneration: "huge", pad }));
    expect(res.status).toBe(413);
    expect(readBotDiskReport(BOT_A)!.report.imageGeneration).toBe("good");
  });

  it("a report that names another bot is 403 and nothing is stored", async () => {
    const res = await request(appFor(agent(BOT_A))).post(URL).send(reportFor(BOT_B));
    expect(res.status).toBe(403);
    expect(readBotDiskReports()).toHaveLength(0);
  });

  it("a board actor is 403 and an anonymous call is 401", async () => {
    expect((await request(appFor(boardActor)).post(URL).send(reportFor(BOT_A))).status).toBe(403);
    expect((await request(appFor({ type: "none", source: "none" })).post(URL).send(reportFor(BOT_A))).status).toBe(401);
    expect(readBotDiskReports()).toHaveLength(0);
  });

  it("two bots do not see each other's reports", async () => {
    await request(appFor(agent(BOT_A))).post(URL).send(reportFor(BOT_A, { imageGeneration: "gen-a" })).expect(200);
    await request(appFor(agent(BOT_B))).post(URL).send(reportFor(BOT_B, { imageGeneration: "gen-b" })).expect(200);
    expect(readBotDiskReport(BOT_A)!.report.imageGeneration).toBe("gen-a");
    expect(readBotDiskReport(BOT_B)!.report.imageGeneration).toBe("gen-b");
    expect(readBotDiskReports().map((e) => e.botKey).sort()).toEqual([BOT_A, BOT_B].sort());
  });
});
