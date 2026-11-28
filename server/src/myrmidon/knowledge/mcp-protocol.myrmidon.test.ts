import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const url = `/api/myrmidon/companies/${companyId}/knowledge/mcp`;
const names = [
  "knowledge_search", "knowledge_read", "knowledge_list", "knowledge_backlinks",
  "knowledge_propose", "knowledge_write_draft", "knowledge_publish", "rule_propose",
];

function setup() {
  const mod = {
    search: vi.fn(async () => [{ id: "result-1" }]),
    create: vi.fn(), draft: vi.fn(), submit: vi.fn(), publish: vi.fn(), suggest: vi.fn(),
  };
  const moduleFor = vi.fn(() => mod);
  const parkPublishForApproval = vi.fn();
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board", source: "session", userId: "operator", isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
    };
    next();
  });
  server.use("/api", knowledgeMcpRoutes({ moduleFor, parkPublishForApproval } as unknown as KnowledgeMcpDeps));
  server.use(errorHandler);
  return { server, mod, moduleFor, parkPublishForApproval };
}

const ids = [
  { label: "zero", request: { id: 0 }, response: 0 },
  { label: "string", request: { id: "request-1" }, response: "request-1" },
  { label: "absent", request: {}, response: null },
];

describe("knowledge MCP protocol and dispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(ids)("initializes with the exact envelope for $label id", async ({ request: id, response: expectedId }) => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", ...id, method: "initialize" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: expectedId, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "myrmidon-knowledge", version: "1" },
    } });
    expectNoWrites(ctx);
  });

  it.each(ids)("accepts initialized notification with no body for $label id", async ({ request: id }) => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", ...id, method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(res.text).toBe("");
    expectNoWrites(ctx);
  });

  it.each(ids)("lists the eight unique tools for $label id", async ({ request: id, response: expectedId }) => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", ...id, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["id", "jsonrpc", "result"]);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.id).toBe(expectedId);
    expect(Object.keys(res.body.result)).toEqual(["tools"]);
    const tools = res.body.result.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(8);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(8);
    expectNoWrites(ctx);
  });

  it.each(ids)("rejects an unknown method for $label id", async ({ request: id, response: expectedId }) => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", ...id, method: "unknown/method" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: expectedId, error: { code: -32601, message: "Method not found" } });
    expectNoWrites(ctx);
  });

  it.each(ids.flatMap((id) => [
    { ...id, name: "unknown_tool", message: "Unknown tool: unknown_tool" },
    { ...id, name: "", message: "Unknown tool: (none)" },
    { ...id, name: undefined, message: "Unknown tool: (none)" },
  ]))("rejects tool '$name' for $label id", async ({ request: id, response: expectedId, name, message }) => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", ...id, method: "tools/call", params: { name } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: expectedId, error: { code: -32602, message } });
    expectNoWrites(ctx);
  });

  it("dispatches a known search tool to the company module", async () => {
    const ctx = setup();
    const res = await request(ctx.server).post(url).send({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "knowledge_search", arguments: { q: "guide", limit: 3 } } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jsonrpc: "2.0", id: 0, result: {
      content: [{ type: "text", text: JSON.stringify({ items: [{ id: "result-1" }] }) }],
      structuredContent: { items: [{ id: "result-1" }] },
    } });
    expect(ctx.moduleFor).toHaveBeenCalledExactlyOnceWith(companyId);
    expect(ctx.mod.search).toHaveBeenCalledExactlyOnceWith("guide", 3);
    expectMutationsAbsent(ctx);
  });
});

function expectMutationsAbsent(ctx: ReturnType<typeof setup>) {
  for (const port of [ctx.mod.create, ctx.mod.draft, ctx.mod.submit, ctx.mod.publish, ctx.mod.suggest, ctx.parkPublishForApproval]) {
    expect(port).not.toHaveBeenCalled();
  }
}

function expectNoWrites(ctx: ReturnType<typeof setup>) {
  expect(ctx.moduleFor).not.toHaveBeenCalled();
  expect(ctx.mod.search).not.toHaveBeenCalled();
  expectMutationsAbsent(ctx);
}
