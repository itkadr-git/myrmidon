import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { KNOWLEDGE_TOOL_ACCESS_DENIED_CODE } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { KnowledgeDomainError } from "./domain.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "11111111-1111-4111-8111-111111111111";
const path = `/api/myrmidon/companies/${COMPANY}/knowledge/search`;
const board = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [COMPANY], memberships: [{ companyId: COMPANY, status: "active", membershipRole: "operator" }] };
const agent = { type: "agent", source: "agent_key", agentId: AGENT, companyId: COMPANY, keyId: "key-a", companyIds: [COMPANY] };

function setup(actor: unknown = board, granted = false) {
  const search = vi.fn(async (_q: string, _limit: number): Promise<unknown[]> => []);
  const moduleFor = vi.fn(() => ({ search }));
  const agentHasToolAccess = vi.fn(async () => granted);
  const deps = { moduleFor, agentHasToolAccess } as unknown as KnowledgeRoutesDeps;
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(deps));
  app.use(errorHandler);
  return { app, search, moduleFor, agentHasToolAccess };
}

describe("myrmidon knowledge search REST boundary", () => {
  it("passes an explicit limit once and preserves query, order, scores and sentinels", async () => {
    const ctx = setup();
    const items = [{ id: "second", score: 0.23, sentinel: "beta" }, { id: "first", score: 0.91, sentinel: null }];
    ctx.search.mockResolvedValueOnce(items);
    const res = await request(ctx.app).get(path).query({ q: "alpha beta", limit: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: "alpha beta", items });
    expect(ctx.moduleFor).toHaveBeenCalledExactlyOnceWith(COMPANY);
    expect(ctx.search).toHaveBeenCalledExactlyOnceWith("alpha beta", 7);
    expect(ctx.agentHasToolAccess).not.toHaveBeenCalled();
  });

  it("uses limit 20 when it is omitted and returns the port's empty result", async () => {
    const ctx = setup();
    const res = await request(ctx.app).get(path).query({ q: "no matches" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: "no matches", items: [] });
    expect(ctx.search).toHaveBeenCalledExactlyOnceWith("no matches", 20);
  });

  it.each([
    ["missing query", {}],
    ["empty query", { q: "" }],
    ["query too long", { q: "x".repeat(501) }],
    ["zero limit", { q: "term", limit: "0" }],
    ["limit above 100", { q: "term", limit: "101" }],
    ["fractional limit", { q: "term", limit: "1.5" }],
    ["non-numeric limit", { q: "term", limit: "nope" }],
  ])("rejects %s without touching the search port", async (_name, query) => {
    const ctx = setup();
    const res = await request(ctx.app).get(path).query(query);
    expect(res.status).toBe(400);
    expect(ctx.moduleFor).not.toHaveBeenCalled();
    expect(ctx.search).not.toHaveBeenCalled();
  });

  it("checks the company, agent and search grant before the permitted search", async () => {
    const ctx = setup(agent, true);
    ctx.search.mockResolvedValueOnce([{ id: "agent-result", score: 0.4 }]);
    const res = await request(ctx.app).get(path).query({ q: "agent query", limit: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: "agent query", items: [{ id: "agent-result", score: 0.4 }] });
    expect(ctx.agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ companyId: COMPANY, agentId: AGENT, toolName: "knowledge_search" });
    expect(ctx.moduleFor).toHaveBeenCalledExactlyOnceWith(COMPANY);
    expect(ctx.search).toHaveBeenCalledExactlyOnceWith("agent query", 3);
  });

  it("denies an agent without the search grant before reading the port", async () => {
    const ctx = setup(agent);
    const res = await request(ctx.app).get(path).query({ q: "term" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(KNOWLEDGE_TOOL_ACCESS_DENIED_CODE);
    expect(ctx.agentHasToolAccess).toHaveBeenCalledExactlyOnceWith({ companyId: COMPANY, agentId: AGENT, toolName: "knowledge_search" });
    expect(ctx.moduleFor).not.toHaveBeenCalled();
    expect(ctx.search).not.toHaveBeenCalled();
  });

  it("returns domain error status and code rather than an empty success", async () => {
    const ctx = setup();
    ctx.search.mockRejectedValueOnce(new KnowledgeDomainError("knowledge_search_unavailable", 409, "Search unavailable"));
    const res = await request(ctx.app).get(path).query({ q: "term", limit: 2 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("knowledge_search_unavailable");
    expect(res.body).not.toHaveProperty("items");
    expect(ctx.search).toHaveBeenCalledExactlyOnceWith("term", 2);
  });
});
