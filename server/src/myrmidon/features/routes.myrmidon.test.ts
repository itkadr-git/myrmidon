// myrmidon(FEATURES): route tests — the auth contract and the shapes of
// GET /api/myrmidon/features and PATCH /api/myrmidon/features/:key.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/error-handler.js";
import { resetFeatureAttention } from "./attention.js";
import { featuresRoutes } from "./routes.js";
import { resetFeatureOutcomes } from "./recorder.js";
import { featuresService } from "./service.js";
import type { FeatureDefinition, FeaturePorts } from "./types.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const admin = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: true, companyIds: [COMPANY] };
const member = { type: "board", source: "session", userId: "user-b", isInstanceAdmin: false, companyIds: [COMPANY] };
const agent = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: COMPANY, keyId: "k" };

const ports = {
  activity: { count: async () => 0, latest: async () => null },
} as unknown as FeaturePorts;

let flips: boolean[] = [];

const switchable: FeatureDefinition = {
  key: "switchable",
  name: "Switchable",
  description: "A feature with an inline switch for the route tests.",
  docs: "docs/myrmidon/SETTINGS.md",
  readConfig: () => ({ enabled: flips.at(-1) ?? false, entries: [], toggle: { enabled: flips.at(-1) ?? false, lockedBy: null } }),
  health: (_ctx, config) =>
    config.enabled
      ? { status: "working", reason: "on", lastSuccessAt: null, lastError: null, errors24h: 0, effect: null }
      : { status: "off", reason: "off", lastSuccessAt: null, lastError: null, errors24h: null, effect: null },
  setEnabled: async (_ctx, enabled) => {
    flips.push(enabled);
  },
};

function app(actor: unknown) {
  const service = featuresService({
    db: {} as unknown as Db,
    ports,
    registry: [switchable],
    readGeneral: async () => ({}),
    env: {},
  });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", featuresRoutes({} as unknown as Db, service));
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  flips = [];
  resetFeatureOutcomes();
  resetFeatureAttention();
});

describe("features routes", () => {
  it("serves the report to a company member", async () => {
    const res = await request(app(member)).get("/api/myrmidon/features").expect(200);
    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0]).toMatchObject({ key: "switchable", health: { status: "off" } });
    expect(res.body.summary.off).toBe(1);
  });

  it("refuses an agent key and an anonymous caller", async () => {
    await request(app(agent)).get("/api/myrmidon/features").expect(403);
    await request(app({ type: "none" })).get("/api/myrmidon/features").expect(403);
  });

  it("flips an inline switch for an instance admin and returns the new row", async () => {
    const res = await request(app(admin)).patch("/api/myrmidon/features/switchable").send({ enabled: true }).expect(200);
    expect(flips).toEqual([true]);
    expect(res.body.health.status).toBe("working");
  });

  it("refuses the switch for a member, an unknown key and a malformed body", async () => {
    await request(app(member)).patch("/api/myrmidon/features/switchable").send({ enabled: true }).expect(403);
    await request(app(admin)).patch("/api/myrmidon/features/missing").send({ enabled: true }).expect(404);
    await request(app(admin)).patch("/api/myrmidon/features/switchable").send({ enabled: "yes" }).expect(400);
    expect(flips).toEqual([]);
  });
});
