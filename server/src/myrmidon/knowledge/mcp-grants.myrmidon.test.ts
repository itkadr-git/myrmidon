import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";
const AGENT = "44444444-4444-4444-8444-444444444444";
const agent = { type: "agent", source: "agent_key", agentId: AGENT, companyId: COMPANY };
const board = {
  type: "board", source: "session", userId: "operator", isInstanceAdmin: false,
  companyIds: [COMPANY], memberships: [{ companyId: COMPANY, status: "active", membershipRole: "operator" }],
};
const item = { id: "item-1", slug: "ops/runbook", title: "Runbook", content: "Read this" };
const denied = {
  jsonrpc: "2.0", id: 1,
  error: { code: -32604, message: "knowledge access requires a tool grant (permissions.toolAccess)", data: { code: { code: "knowledge_tool_access_denied" } } },
};

function fixture(actor: unknown, grant?: KnowledgeMcpDeps["agentHasToolAccess"]) {
  const mod = {
    get: vi.fn(async () => item), search: vi.fn(), listItems: vi.fn(), backlinks: vi.fn(),
    suggest: vi.fn(), draft: vi.fn(), create: vi.fn(), submit: vi.fn(), publish: vi.fn(),
  };
  const moduleFor = vi.fn(() => mod);
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", knowledgeMcpRoutes({ moduleFor, agentHasToolAccess: grant } as unknown as KnowledgeMcpDeps));
  server.use(errorHandler);
  const call = (name = "knowledge_read", companyId = COMPANY) => request(server)
    .post(`/api/myrmidon/companies/${companyId}/knowledge/mcp`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { idOrSlug: item.slug, q: "runbook" } } });
  const expectNoStore = () => {
    expect(moduleFor).not.toHaveBeenCalled();
    for (const port of Object.values(mod)) expect(port).not.toHaveBeenCalled();
  };
  return { call, mod, moduleFor, expectNoStore };
}

function expectReadResponse(response: request.Response) {
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    jsonrpc: "2.0", id: 1,
    result: { content: [{ type: "text", text: JSON.stringify({ item }) }], structuredContent: { item } },
  });
}

describe("knowledge MCP company and tool grants", () => {
  it("denies an agent when the grant callback is absent before any store access", async () => {
    const f = fixture(agent);
    const response = await f.call();
    expect(response.status).toBe(403);
    expect(response.body).toEqual(denied);
    f.expectNoStore();
  });

  it("denies a false grant before any store access", async () => {
    const grant = vi.fn(async () => false);
    const f = fixture(agent, grant);
    const response = await f.call();
    expect(response.status).toBe(403);
    expect(response.body).toEqual(denied);
    expect(grant).toHaveBeenCalledExactlyOnceWith({ agentId: AGENT, companyId: COMPANY, toolName: "knowledge_read" });
    f.expectNoStore();
  });

  it("allows only the granted tool and reads exactly once", async () => {
    const grant = vi.fn(async ({ toolName }: { toolName: string }) => toolName === "knowledge_read");
    const f = fixture(agent, grant);
    expectReadResponse(await f.call());
    expect(f.moduleFor).toHaveBeenCalledExactlyOnceWith(COMPANY);
    expect(f.mod.get).toHaveBeenCalledExactlyOnceWith(item.slug);
    const response = await f.call("knowledge_search");
    expect(response.status).toBe(403);
    expect(response.body).toEqual(denied);
    expect(grant.mock.calls).toEqual([
      [{ agentId: AGENT, companyId: COMPANY, toolName: "knowledge_read" }],
      [{ agentId: AGENT, companyId: COMPANY, toolName: "knowledge_search" }],
    ]);
    expect(f.moduleFor).toHaveBeenCalledTimes(1);
    expect(f.mod.search).not.toHaveBeenCalled();
    expect(f.mod.get).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign company before checking grants or opening the store", async () => {
    const grant = vi.fn(async () => true);
    const f = fixture(agent, grant);
    const response = await f.call("knowledge_read", OTHER_COMPANY);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Agent key cannot access another company" });
    expect(grant).not.toHaveBeenCalled();
    f.expectNoStore();
  });

  it("allows a board operator in its company without an agent grant", async () => {
    const grant = vi.fn(async () => false);
    const f = fixture(board, grant);
    expectReadResponse(await f.call());
    expect(grant).not.toHaveBeenCalled();
    expect(f.moduleFor).toHaveBeenCalledExactlyOnceWith(COMPANY);
    expect(f.mod.get).toHaveBeenCalledExactlyOnceWith(item.slug);
  });
});
