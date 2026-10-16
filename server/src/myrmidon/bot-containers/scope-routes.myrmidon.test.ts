// myrmidon(BOT-DISK-F): the scope API: who may read, who may write, validation,
// and that every route reaches the service. A fake service, no database.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { botScopeRoutes } from "./scope-routes.js";
import type { BotScopeService } from "./scope-service.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const GROUP = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";

const admin = { type: "board", source: "session", userId: "u1", isInstanceAdmin: true, companyIds: [COMPANY] };
const member = { type: "board", source: "session", userId: "u2", isInstanceAdmin: false, companyIds: [COMPANY] };
const outsider = { type: "board", source: "session", userId: "u3", isInstanceAdmin: false, companyIds: ["other"] };
const agentActor = { type: "agent", source: "agent_key", agentId: AGENT, companyId: COMPANY, keyId: "k" };

function fakeService() {
  const overview = { companyId: COMPANY, scopeRoot: "/srv/scopes", agents: [], groups: [], instances: [] };
  const service = {
    overview: vi.fn(async () => overview),
    createGroup: vi.fn(async () => ({ id: GROUP, name: "devs", memberIds: [], mode: null })),
    patchGroup: vi.fn(async () => ({ id: GROUP, name: "builders", memberIds: [], mode: null })),
    deleteGroup: vi.fn(async () => undefined),
    putSetting: vi.fn(async () => overview),
    deleteSetting: vi.fn(async () => overview),
    putAgentPref: vi.fn(async () => ({ agentId: AGENT })),
    apply: vi.fn(async () => ({ agentId: AGENT })),
    applyAll: vi.fn(async () => ({ applied: [], skipped: [] })),
    appliedLayout: vi.fn(),
  };
  return { service, overview };
}

function app(actor: unknown, service: ReturnType<typeof fakeService>["service"]) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", botScopeRoutes(service as unknown as BotScopeService));
  server.use(errorHandler);
  return server;
}

const base = `/api/myrmidon/companies/${COMPANY}/bot-scopes`;

describe("bot scope routes", () => {
  it("a board member of the company reads the overview", async () => {
    const { service, overview } = fakeService();
    const res = await request(app(member, service)).get(base);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(overview);
    expect(service.overview).toHaveBeenCalledWith(COMPANY);
  });

  it("a member of another company and an agent cannot read", async () => {
    const { service } = fakeService();
    expect((await request(app(outsider, service)).get(base)).status).toBe(404);
    expect((await request(app(agentActor, service)).get(base)).status).toBeGreaterThanOrEqual(401);
    expect(service.overview).not.toHaveBeenCalled();
  });

  it("writes need instance-admin rights", async () => {
    const { service } = fakeService();
    for (const [method, url, body] of [
      ["post", `${base}/groups`, { name: "devs" }],
      ["patch", `${base}/groups/${GROUP}`, { name: "x" }],
      ["delete", `${base}/groups/${GROUP}`, undefined],
      ["put", `${base}/settings/caste/engineer`, { mode: "shared" }],
      ["delete", `${base}/settings/caste/engineer`, undefined],
      ["put", `${base}/agents/${AGENT}`, { isolate: true }],
      ["post", `${base}/agents/${AGENT}/apply`, undefined],
      ["post", `${base}/apply-all`, undefined],
    ] as const) {
      const res = await (request(app(member, service)) as any)[method](url).send(body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(service.createGroup).not.toHaveBeenCalled();
    expect(service.apply).not.toHaveBeenCalled();
  });

  it("an admin drives every operation through the service", async () => {
    const { service } = fakeService();
    const a = app(admin, service);
    expect((await request(a).post(`${base}/groups`).send({ name: "devs", memberIds: [AGENT] })).status).toBe(201);
    expect(service.createGroup).toHaveBeenCalledWith(COMPANY, { name: "devs", memberIds: [AGENT] });
    expect((await request(a).patch(`${base}/groups/${GROUP}`).send({ name: "builders" })).status).toBe(200);
    expect(service.patchGroup).toHaveBeenCalledWith(COMPANY, GROUP, { name: "builders" });
    expect((await request(a).delete(`${base}/groups/${GROUP}`)).status).toBe(204);
    expect((await request(a).put(`${base}/settings/caste/engineer`).send({ mode: "shared" })).status).toBe(200);
    expect(service.putSetting).toHaveBeenCalledWith(COMPANY, "caste", "engineer", "shared");
    expect((await request(a).delete(`${base}/settings/project/${GROUP}`)).status).toBe(200);
    expect(service.deleteSetting).toHaveBeenCalledWith(COMPANY, "project", GROUP);
    expect((await request(a).put(`${base}/agents/${AGENT}`).send({ isolate: true, groupId: null })).status).toBe(200);
    expect(service.putAgentPref).toHaveBeenCalledWith(COMPANY, AGENT, { isolate: true, groupId: null });
    expect((await request(a).post(`${base}/agents/${AGENT}/apply`)).status).toBe(200);
    expect((await request(a).post(`${base}/apply-all`)).status).toBe(200);
  });

  it("rejects bad input before the service: unknown kind, mode, extra keys, non-uuid ids, empty names", async () => {
    const { service } = fakeService();
    const a = app(admin, service);
    expect((await request(a).put(`${base}/settings/agent/${AGENT}`).send({ mode: "shared" })).status).toBe(400);
    expect((await request(a).put(`${base}/settings/caste/engineer`).send({ mode: "everyone" })).status).toBe(400);
    expect((await request(a).put(`${base}/settings/caste/engineer`).send({ mode: "shared", extra: 1 })).status).toBe(400);
    expect((await request(a).post(`${base}/groups`).send({ name: "   " })).status).toBe(400);
    expect((await request(a).post(`${base}/groups`).send({ name: "x", memberIds: ["nope"] })).status).toBe(400);
    expect((await request(a).patch(`${base}/groups/not-a-uuid`).send({ name: "x" })).status).toBe(404);
    expect((await request(a).post(`${base}/agents/not-a-uuid/apply`)).status).toBe(404);
    expect((await request(a).put(`${base}/agents/${AGENT}`).send({ projectId: "nope" })).status).toBe(400);
    expect(service.putSetting).not.toHaveBeenCalled();
    expect(service.createGroup).not.toHaveBeenCalled();
  });
});
