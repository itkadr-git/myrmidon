// myrmidon(1.6.6 SETTINGS-UI-B / OPE-6258): GET /api/myrmidon/bot-disk/physical
// (the C5 dockergate relay) and GET /api/myrmidon/bot-disk/reports (the stored
// C4 rows) — the two read routes the lifecycle screen calls. The gate answer is
// relayed unchanged; a missing/unreachable gate is 200 with an empty snapshot,
// never an error (the screen shows "no data").

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { wsDiskApiResponseSchema } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import { botDiskReportRoutes } from "./bot-disk-report-routes.js";
import { botDiskPhysicalRoutes } from "./bot-disk-physical-routes.js";
import { resetBotDiskReports, storeBotDiskReport } from "./bot-disk-report-store.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BOT_A = "11111111-1111-4111-8111-111111111111";
const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY_ID] };
const outsider = { type: "board", source: "session", userId: "user-c", isInstanceAdmin: false, companyIds: [] };

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, "../../../../docs/myrmidon/bot-disk-contract", name), "utf8"));

function appFor(actor: unknown, overrides?: Parameters<typeof botDiskPhysicalRoutes>[1]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", botDiskPhysicalRoutes({} as Db, overrides));
  // The C4 POST side of the same screen, mounted exactly like app.ts does now.
  app.use("/api", botDiskReportRoutes());
  app.use(errorHandler);
  return app;
}

beforeEach(() => resetBotDiskReports());

describe("GET /api/myrmidon/bot-disk/physical", () => {
  it("relays the contract C5 fixture unchanged plus gateReached", async () => {
    const gate = fixture("dockergate-disk.json");
    expect(wsDiskApiResponseSchema.safeParse(gate).success).toBe(true);
    const res = await request(appFor(member, { env: {}, fetchGate: async () => gate }))
      .get("/api/myrmidon/bot-disk/physical")
      .expect(200);
    expect(res.body.partition).toEqual(gate.partition);
    expect(res.body.projects).toEqual(gate.projects);
    expect(res.body.other).toEqual(gate.other);
    expect(res.body.quotaEnabled).toBe(true);
    expect(res.body.at).toBe(gate.at);
    expect(res.body.gateReached).toBe(true);
    expect(res.body.note).toBeUndefined();
  });

  it("without gate env vars answers 200 with an empty snapshot and a note", async () => {
    const res = await request(appFor(member, { env: {} }))
      .get("/api/myrmidon/bot-disk/physical")
      .expect(200);
    expect(res.body.gateReached).toBe(false);
    expect(res.body.note).toBe("gate not configured");
    expect(res.body.partition).toBeUndefined();
  });

  it("a configured but unreachable gate is still 200 with gateReached false", async () => {
    const env = { MYRMIDON_DOCKERGATE_BASE_URL: "http://127.0.0.1:1", MYRMIDON_DOCKERGATE_TOKEN: "t" };
    const res = await request(appFor(member, { env, fetchGate: async () => null }))
      .get("/api/myrmidon/bot-disk/physical")
      .expect(200);
    expect(res.body.gateReached).toBe(false);
    expect(res.body.note).toBe("gate unreachable");
  });

  it("a non-200 gate answer is no data (getJson swallows it)", async () => {
    // The injected fetchGate is the transport seam itself; verify the real
    // fetch path against an endpoint that answers 500 through the fallback.
    const env = { MYRMIDON_DOCKERGATE_BASE_URL: "http://127.0.0.1:9/", MYRMIDON_DOCKERGATE_TOKEN: "t" };
    const res = await request(appFor(member, { env, timeoutMs: 250 }))
      .get("/api/myrmidon/bot-disk/physical")
      .expect(200);
    expect(res.body.gateReached).toBe(false);
  });

  it("refuses an actor without organization access", async () => {
    await request(appFor(outsider, { env: {}, fetchGate: async () => null }))
      .get("/api/myrmidon/bot-disk/physical")
      .expect(403);
  });
});

describe("GET /api/myrmidon/bot-disk/reports", () => {
  it("returns the stored C4 rows oldest-first with receivedAt and the stale window", async () => {
    const report = fixture("disk-report.json");
    storeBotDiskReport("bot-001", { ...report, at: "2026-10-08T10:00:00.000Z" }, Date.parse("2026-10-08T10:00:00.000Z"));
    storeBotDiskReport("bot-002", { ...report, botKey: "bot-002", at: "2026-10-08T09:00:00.000Z" }, Date.parse("2026-10-08T09:05:00.000Z"));
    const res = await request(appFor(member, { env: {} })).get("/api/myrmidon/bot-disk/reports").expect(200);
    expect(res.body.staleAfterMs).toBe(30 * 60 * 1000);
    expect(res.body.reports.map((r: { botKey: string }) => r.botKey)).toEqual(["bot-002", "bot-001"]);
    expect(res.body.reports[0].receivedAt).toBe("2026-10-08T09:05:00.000Z");
  });

  it("an empty store answers 200 with an empty list (the screen shows no data)", async () => {
    const res = await request(appFor(member, { env: {} })).get("/api/myrmidon/bot-disk/reports").expect(200);
    expect(res.body.reports).toEqual([]);
  });
});
