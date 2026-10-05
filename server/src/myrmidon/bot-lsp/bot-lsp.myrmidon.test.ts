// myrmidon(BOT-LSP-DEFAULTS): the bot-lsp routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, bots walk), so validation, permissions, the audit record and the
// per-bot resolution are exercised without a database.
//
// Neutral data only: agent-a.., company ids are fixed fakes.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../middleware/index.js";
import { botLspRoutes } from "./routes.js";
import {
  BOT_LSP_ACTION,
  botLspService,
  mergeBotLspSettings,
  type BotLspAgentCard,
  type BotLspServiceDeps,
} from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };
const outsider = { ...member, userId: "user-c", companyIds: [] };
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function harness(options: { stored?: unknown; companyIds?: string[]; bots?: BotLspAgentCard[] } = {}) {
  const updated: Array<{ botLsp: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored as unknown };

  const deps: Partial<BotLspServiceDeps> = {
    settings: {
      getGeneral: async () => ({ botLsp: current.stored }),
      updateGeneral: async (patch: { botLsp: unknown }) => {
        current.stored = patch.botLsp;
        updated.push(patch as { botLsp: unknown });
        return {};
      },
    },
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    listBots: async () => options.bots ?? [],
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", botLspRoutes({} as Db, botLspService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(member), withActor, updated, audits };
}

const URL = "/api/myrmidon/bot-lsp";

const BOTS: BotLspAgentCard[] = [
  { id: "a", name: "agent-a", role: "engineer", adapterConfig: {} },
  { id: "b", name: "agent-b", role: "general", adapterConfig: {} },
  { id: "c", name: "agent-c", role: "cmo", adapterConfig: { lsp: { mode: "limited" } } },
  { id: "d", name: "agent-d", role: "reviewer", adapterConfig: { lsp: { mode: "off" } } },
];

describe("myrmidon(BOT-LSP-DEFAULTS) routes: reading", () => {
  it("reports the module defaults with nothing stored", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({});
    expect(res.body.effective).toEqual({
      codingRoles: ["engineer", "qa", "devops", "reviewer", "release"],
      codingMode: "limited",
      nonCodingMode: "off",
      idleTimeoutSeconds: 120,
      tsserverMemoryMb: 1024,
      excludeRoots: [],
    });
    expect(res.body.counts).toEqual({ off: 0, limited: 0, full: 0 });
  });

  it("resolves every bot the way the compiler does: role policy, card pin wins", async () => {
    const { app } = harness({ bots: BOTS });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.agents).toEqual([
      { id: "a", name: "agent-a", role: "engineer", mode: "limited", source: "role" },
      { id: "b", name: "agent-b", role: "general", mode: "off", source: "role" },
      { id: "c", name: "agent-c", role: "cmo", mode: "limited", source: "card" },
      { id: "d", name: "agent-d", role: "reviewer", mode: "off", source: "card" },
    ]);
    expect(res.body.counts).toEqual({ off: 2, limited: 2, full: 0 });
  });

  it("is readable by a board member, denied for an agent and an outsider", async () => {
    const { app, withActor } = harness();
    await request(app).get(URL).expect(200);
    await request(withActor(agentActor)).get(URL).expect(403);
    await request(withActor(outsider)).get(URL).expect(403);
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) routes: writing", () => {
  it("is instance-admin only", async () => {
    const { withActor, updated } = harness();
    await request(withActor(admin)).patch(URL).send({ nonCodingMode: "limited" }).expect(200);
    expect(updated).toHaveLength(1);
    await request(withActor(member)).patch(URL).send({ nonCodingMode: "limited" }).expect(403);
    await request(withActor(agentActor)).patch(URL).send({ nonCodingMode: "limited" }).expect(403);
    expect(updated).toHaveLength(1);
  });

  it("merges a partial patch, removes a null field and audits for every company", async () => {
    const { withActor, updated, audits } = harness({
      stored: { codingRoles: ["engineer"], idleTimeoutSeconds: 300 },
      companyIds: [COMPANY_ID, "33333333-3333-4333-8333-333333333333"],
      bots: BOTS,
    });
    const res = await request(withActor(admin))
      .patch(URL)
      .send({ codingRoles: ["engineer", "reviewer"], idleTimeoutSeconds: null, codingMode: "full" })
      .expect(200);
    expect(updated[0]?.botLsp).toEqual({ codingRoles: ["engineer", "reviewer"], codingMode: "full" });
    expect(res.body.effective.idleTimeoutSeconds).toBe(120);
    expect(res.body.agents.find((agent: { id: string }) => agent.id === "a").mode).toBe("full");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ action: BOT_LSP_ACTION, entityType: "instance_settings" });
    expect(audits[0]?.details).toMatchObject({ changedKeys: ["codingRoles", "codingMode", "idleTimeoutSeconds"] });
  });

  it("rejects invalid bodies with 400", async () => {
    const { app, updated } = harness();
    await request(app).patch(URL).send({ codingMode: "sometimes" }).expect(400);
    await request(app).patch(URL).send({ idleTimeoutSeconds: 5 }).expect(400);
    await request(app).patch(URL).send({ tsserverMemoryMb: 100 }).expect(400);
    await request(app).patch(URL).send({ codingRoles: ["not a key"] }).expect(400);
    await request(app).patch(URL).send({ unknown: true }).expect(400);
    expect(updated).toHaveLength(0);
  });
});

describe("myrmidon(BOT-LSP-DEFAULTS) mergeBotLspSettings", () => {
  it("keeps fields the patch leaves out", () => {
    expect(mergeBotLspSettings({ codingMode: "off", tsserverMemoryMb: 2048 }, { nonCodingMode: "limited" })).toEqual({
      codingMode: "off",
      tsserverMemoryMb: 2048,
      nonCodingMode: "limited",
    });
  });
});
