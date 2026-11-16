import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { resolveKnowledgeSettings } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { myrmidonKnowledgeSettingsRoutes } from "./settings-routes.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const path = (companyId: string) => `/api/myrmidon/companies/${companyId}/knowledge/settings`;

const board = (isInstanceAdmin = false): express.Request["actor"] => ({
  type: "board",
  source: "session",
  userId: "user-1",
  isInstanceAdmin,
  companyIds: [COMPANY_A],
  memberships: [{ companyId: COMPANY_A, status: "active", membershipRole: "member" }],
});

const agent: express.Request["actor"] = {
  type: "agent",
  source: "agent_key",
  agentId: "agent-1",
  companyId: COMPANY_A,
  keyId: "key-1",
  companyIds: [COMPANY_A],
};

function makeApp(actor: express.Request["actor"]) {
  const view = resolveKnowledgeSettings({});
  const read = vi.fn(async (_companyId: string) => view);
  const update = vi.fn(async () => view);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", myrmidonKnowledgeSettingsRoutes(null as unknown as Db, {}, { read, update }));
  app.use(errorHandler);
  return { app, read, update, view };
}

describe("knowledge settings company and admin gate", () => {
  it("allows a board member to read its company", async () => {
    const { app, read, update, view } = makeApp(board());
    const response = await request(app).get(path(COMPANY_A));
    expect(response.status).toBe(200);
    expect(response.body).toEqual(view);
    expect(read).toHaveBeenCalledExactlyOnceWith(COMPANY_A);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([["board member", board()], ["agent", agent]] as const)(
    "denies %s access to another company before calling the service",
    async (_label, actor) => {
      const { app, read, update } = makeApp(actor);
      const response = await request(app).get(path(COMPANY_B));
      expect(response.status).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("allows an agent to read its company but not update it", async () => {
    const { app, read, update, view } = makeApp(agent);
    const get = await request(app).get(path(COMPANY_A));
    expect(get.status).toBe(200);
    expect(get.body).toEqual(view);
    expect(read).toHaveBeenCalledExactlyOnceWith(COMPANY_A);
    const patch = await request(app).patch(path(COMPANY_A)).send({ maxItems: "100" });
    expect(patch.status).toBe(403);
    expect(read).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a non-admin before parsing an invalid patch", async () => {
    const { app, read, update } = makeApp(board());
    const response = await request(app).patch(path(COMPANY_A)).send({ maxItems: 123 });
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("allows an instance admin with company access to update once with user actor", async () => {
    const { app, read, update, view } = makeApp(board(true));
    const response = await request(app).patch(path(COMPANY_A)).send({ maxItems: "100" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(view);
    expect(read).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(COMPANY_A, { maxItems: "100" }, {
      actorType: "user",
      actorId: "user-1",
      agentId: null,
      runId: null,
    });
  });
});
