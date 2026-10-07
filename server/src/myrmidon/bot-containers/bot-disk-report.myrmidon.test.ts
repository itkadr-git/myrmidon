// myrmidon(1.6.5-BOT-DISK-H4b): the disk-report ingest route (C4) and the two
// board reads the «Диск ботов» panel uses.
//
// Plain fakes for the agent lookup and the partition measurement; the real
// shared schema, the real router and the real error handler underneath, so the
// status codes and the body shapes here are the ones a bot and the board get.
// The contract fixtures in docs/myrmidon/bot-disk-contract/ are posted as they
// are (only `botKey` is set to the calling bot, which the contract leaves to the
// bot's own key).

import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { wsDiskReportResponseSchema, wsDiskReportSchema } from "@paperclipai/shared";
import { errorHandler } from "../../middleware/index.js";
import {
  BOT_DISK_NEXT_REPORT_SEC,
  BOT_DISK_REPORT_TOO_LARGE,
  botDiskReportRoutes,
  type BotDiskReportAgent,
  type BotDiskReportRoutesDeps,
} from "./bot-disk-report-routes.js";
import { readBotDiskReport, resetBotDiskReportsForTests } from "./bot-disk-report-store.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const BOT_B_ID = "22222222-2222-4222-8222-222222222222";
const PLAIN_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const COMPANY_ID = "44444444-4444-4444-8444-444444444444";

const boardMember = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: AGENT_ID,
  companyId: COMPANY_ID,
  keyId: "key-a",
};
const agentActorB = { ...agentActor, agentId: BOT_B_ID, keyId: "key-b" };
const plainAgentActor = { ...agentActor, agentId: PLAIN_AGENT_ID, keyId: "key-c" };
const anonymous = { type: "none" };

const FIXTURE_DIR = new URL("../../../../docs/myrmidon/bot-disk-contract/", import.meta.url);
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as Record<string, unknown>;
}

const REPORT_FIXTURE = fixture("disk-report.json");
const RESPONSE_FIXTURE = fixture("disk-report-response.json");

const PARTITION = {
  mount: "/bot-volumes",
  totalBytes: 400 * 1024 * 1024 * 1024,
  usedBytes: 220 * 1024 * 1024 * 1024,
  freeBytes: 180 * 1024 * 1024 * 1024,
  usedPercent: 55,
};

function botCard(id: string, adapterType = "hermes_gateway"): BotDiskReportAgent {
  return {
    id,
    companyId: COMPANY_ID,
    adapterType,
    adapterConfig: {
      container: { enabled: true, image: "bot-image:1.1.0", memoryMb: 2048, cpus: 1, pidsLimit: 512 },
    },
  };
}

const CARDS = new Map<string, BotDiskReportAgent>([
  [AGENT_ID, botCard(AGENT_ID)],
  [BOT_B_ID, botCard(BOT_B_ID)],
  [PLAIN_AGENT_ID, botCard(PLAIN_AGENT_ID, "claude")],
]);

function deps(overrides: Partial<BotDiskReportRoutesDeps> = {}): BotDiskReportRoutesDeps {
  return {
    getAgent: async (id) => CARDS.get(id) ?? null,
    botVolumeRoot: () => PARTITION.mount,
    measureUsage: async () => ({ ...PARTITION }),
    ...overrides,
  };
}

function app(actor: unknown, overrides: Partial<BotDiskReportRoutesDeps> = {}) {
  const server = express();
  // The same capture app.ts installs: the route measures the raw bytes.
  server.use(
    express.json({
      limit: "10mb",
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", botDiskReportRoutes(deps(overrides)));
  server.use(errorHandler);
  return server;
}

const REPORT_URL = "/api/myrmidon/bots/me/disk-report";
const REPORTS_URL = "/api/myrmidon/bot-disk/reports";
const PHYSICAL_URL = "/api/myrmidon/bot-disk/physical";

/** The contract fixture as the calling bot would send it. */
function reportFor(botKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...REPORT_FIXTURE, botKey, ...overrides };
}

beforeEach(() => {
  resetBotDiskReportsForTests();
});

describe("myrmidon(1.6.5-BOT-DISK-H4b) disk-report contract", () => {
  it("keeps the schema and the fixture in step", () => {
    expect(wsDiskReportSchema.safeParse(REPORT_FIXTURE).success).toBe(true);
    expect(wsDiskReportResponseSchema.safeParse(RESPONSE_FIXTURE).success).toBe(true);
    expect(RESPONSE_FIXTURE.nextReportSec).toBe(BOT_DISK_NEXT_REPORT_SEC);
  });
});

describe("myrmidon(1.6.5-BOT-DISK-H4b) disk-report ingest", () => {
  it("accepts the contract report and answers the contract response", async () => {
    const res = await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(200);
    expect(res.body).toEqual(RESPONSE_FIXTURE);
    expect(wsDiskReportResponseSchema.safeParse(res.body).success).toBe(true);
  });

  it("files the report under the calling bot and serves it to the board", async () => {
    await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(200);

    const stored = readBotDiskReport(AGENT_ID);
    expect(stored?.report).toEqual(reportFor(AGENT_ID));
    expect(stored?.reportedAtMs).toBe(Date.parse(String(REPORT_FIXTURE.at)));

    const res = await request(app(boardMember)).get(REPORTS_URL).expect(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].botKey).toBe(AGENT_ID);
    expect(res.body.reports[0].imageGeneration).toBe(REPORT_FIXTURE.imageGeneration);
    expect(res.body.reports[0].report).toEqual(reportFor(AGENT_ID));
    expect(wsDiskReportSchema.safeParse(res.body.reports[0].report).success).toBe(true);
  });

  it("answers 400 and keeps the previous report when the body is not a report", async () => {
    await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(200);

    const res = await request(app(agentActor))
      .post(REPORT_URL)
      .send({ schema: 2, botKey: AGENT_ID })
      .expect(400);
    expect(res.body.error).toBeTruthy();

    expect(readBotDiskReport(AGENT_ID)?.report).toEqual(reportFor(AGENT_ID));
  });

  it("answers 400 for a report over the action bound and keeps the previous report", async () => {
    await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(200);

    const action = { at: "2026-10-06T14:01:00Z", action: "archive", path: "/workspace/ABC-099", result: "ok" };
    const tooMany = reportFor(AGENT_ID, { actions: Array.from({ length: 201 }, () => action) });
    await request(app(agentActor)).post(REPORT_URL).send(tooMany).expect(400);

    expect(readBotDiskReport(AGENT_ID)?.report).toEqual(reportFor(AGENT_ID));
  });

  it("answers 413 for a body over the C4 cap and keeps the previous report", async () => {
    await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(200);

    const huge = reportFor(AGENT_ID, {
      copies: [
        {
          path: `/${"x".repeat(1_200_000)}`,
          class: "G",
          key: "probe",
          clean: null,
          pushed: null,
          sizeBytes: null,
          ageSec: 1,
        },
      ],
    });
    const res = await request(app(agentActor)).post(REPORT_URL).send(huge).expect(413);
    expect(res.body.error).toBe(BOT_DISK_REPORT_TOO_LARGE);

    expect(readBotDiskReport(AGENT_ID)?.report).toEqual(reportFor(AGENT_ID));
  });
});

describe("myrmidon(1.6.5-BOT-DISK-H4b) disk-report access", () => {
  it("refuses a report filed for another bot's key", async () => {
    await request(app(agentActorB)).post(REPORT_URL).send(reportFor(BOT_B_ID)).expect(200);

    await request(app(agentActor)).post(REPORT_URL).send(reportFor(BOT_B_ID)).expect(403);

    // B's report is untouched by A's attempt, and A never got a slot.
    expect(readBotDiskReport(AGENT_ID)).toBeNull();
    expect(readBotDiskReport(BOT_B_ID)?.report).toEqual(reportFor(BOT_B_ID));
  });

  it("keeps two bots in separate slots", async () => {
    await request(app(agentActor)).post(REPORT_URL).send(reportFor(AGENT_ID, { imageGeneration: "gen-a" })).expect(200);
    await request(app(agentActorB)).post(REPORT_URL).send(reportFor(BOT_B_ID, { imageGeneration: "gen-b" })).expect(200);

    const res = await request(app(boardMember)).get(REPORTS_URL).expect(200);
    const byKey = new Map<string, { imageGeneration: string }>(
      res.body.reports.map((row: { botKey: string; imageGeneration: string }) => [row.botKey, row]),
    );
    expect([...byKey.keys()].sort()).toEqual([AGENT_ID, BOT_B_ID].sort());
    expect(byKey.get(AGENT_ID)?.imageGeneration).toBe("gen-a");
    expect(byKey.get(BOT_B_ID)?.imageGeneration).toBe("gen-b");
  });

  it("refuses a board session and an anonymous caller on the write", async () => {
    await request(app(boardMember)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(403);
    await request(app(anonymous)).post(REPORT_URL).send(reportFor(AGENT_ID)).expect(401);
    expect(readBotDiskReport(AGENT_ID)).toBeNull();
  });

  it("refuses an agent key that is not a bot container", async () => {
    await request(app(plainAgentActor)).post(REPORT_URL).send(reportFor(PLAIN_AGENT_ID)).expect(403);
    expect(readBotDiskReport(PLAIN_AGENT_ID)).toBeNull();
  });

  it("refuses agent keys on both panel reads", async () => {
    await request(app(agentActor)).get(REPORTS_URL).expect(403);
    await request(app(agentActor)).get(PHYSICAL_URL).expect(403);
  });
});

describe("myrmidon(1.6.5-BOT-DISK-H4b) bot partition read", () => {
  it("answers the C5 shape from the measured partition", async () => {
    const res = await request(app(boardMember)).get(PHYSICAL_URL).expect(200);
    expect(res.body.partition).toEqual(PARTITION);
    expect(res.body.other).toEqual({ usedBytes: PARTITION.usedBytes });
    expect(res.body.projects).toEqual([]);
    expect(res.body.quotaEnabled).toBe(false);
    expect(res.body.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("takes the mount from the bot volume root", async () => {
    const seen: string[] = [];
    const server = app(boardMember, {
      botVolumeRoot: () => "/bot-volumes",
      measureUsage: async (directory) => {
        seen.push(directory);
        return { ...PARTITION, mount: directory };
      },
    });
    await request(server).get(PHYSICAL_URL).expect(200);
    expect(seen).toEqual(["/bot-volumes"]);
  });

  it("answers 503 when the partition is not measurable", async () => {
    await request(app(boardMember, { botVolumeRoot: () => null })).get(PHYSICAL_URL).expect(503);
    await request(app(boardMember, { measureUsage: async () => null })).get(PHYSICAL_URL).expect(503);
  });
});