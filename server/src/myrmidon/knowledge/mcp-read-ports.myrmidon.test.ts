import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeMcpRoutes, type KnowledgeMcpDeps } from "./mcp.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const actor = {
  type: "board", source: "session", userId: "user-op", isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "operator" }],
};
const item = { id: "item-1", slug: "ops/runbook", kind: "note", status: "published" };

function setup() {
  const mod = {
    search: vi.fn(async (_q: string, _limit: number) => [item]),
    listItems: vi.fn(async (_filters: unknown) => [item]),
    get: vi.fn(async (_id: string): Promise<typeof item | null> => item),
    backlinks: vi.fn(async (_id: string) => [{ id: "link-1" }]),
    create: vi.fn(), draft: vi.fn(), submit: vi.fn(), suggest: vi.fn(), publish: vi.fn(),
  };
  const moduleFor = vi.fn(() => mod);
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = actor; next(); });
  server.use("/api", knowledgeMcpRoutes({ moduleFor } as unknown as KnowledgeMcpDeps));
  server.use(errorHandler);
  const call = (name: string, args: Record<string, unknown>) => request(server)
    .post(`/api/myrmidon/companies/${companyId}/knowledge/mcp`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { mod, moduleFor, call };
}

function success(response: { status: number; body: unknown }, value: unknown) {
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, result: {
    content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
  } });
}

describe("knowledge MCP read ports", () => {
  const contexts: ReturnType<typeof setup>[] = [];
  const fresh = () => { const context = setup(); contexts.push(context); return context; };
  afterEach(() => {
    for (const { mod, moduleFor } of contexts.splice(0)) {
      expect(moduleFor).toHaveBeenCalledWith(companyId);
      for (const port of [mod.create, mod.draft, mod.submit, mod.suggest, mod.publish]) expect(port).not.toHaveBeenCalled();
    }
  });

  it("trims search and forwards the numeric limit", async () => {
    const { mod, call } = fresh();
    success(await call("knowledge_search", { q: "  handbook  ", limit: 3 }), { items: [item] });
    expect(mod.search).toHaveBeenCalledExactlyOnceWith("handbook", 3);
  });

  it("defaults search limit to 20", async () => {
    const { mod, call } = fresh();
    success(await call("knowledge_search", { q: "ops" }), { items: [item] });
    expect(mod.search).toHaveBeenCalledExactlyOnceWith("ops", 20);
  });

  it("rejects blank search before calling the port", async () => {
    const { mod, call } = fresh();
    const response = await call("knowledge_search", { q: "  \t " });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, error: {
      code: -32000, message: "knowledge_search requires a non-empty q.",
      data: { code: { code: "knowledge_search_requires_q" } },
    } });
    expect(mod.search).not.toHaveBeenCalled();
  });

  it("forwards list filters, limits results and does not mutate the port array", async () => {
    const { mod, call } = fresh();
    const items = [item, { ...item, id: "item-2" }, { ...item, id: "item-3" }];
    const before = structuredClone(items);
    mod.listItems.mockResolvedValue(items);
    success(await call("knowledge_list", { space: "ops", kind: "note", status: "published", limit: 2 }), { items: before.slice(0, 2) });
    expect(mod.listItems).toHaveBeenCalledExactlyOnceWith({ folderPrefix: "ops", kind: "note", status: "published" });
    expect(items).toEqual(before);
  });

  it("defaults list limit to 50 without mutating the port array", async () => {
    const { mod, call } = fresh();
    const items = Array.from({ length: 52 }, (_, i) => ({ ...item, id: `item-${i}` }));
    const before = structuredClone(items);
    mod.listItems.mockResolvedValue(items);
    success(await call("knowledge_list", {}), { items: before.slice(0, 50) });
    expect(mod.listItems).toHaveBeenCalledExactlyOnceWith({ folderPrefix: undefined, kind: undefined, status: undefined });
    expect(items).toEqual(before);
  });

  it("supports zero and a limit larger than the list", async () => {
    const { mod, call } = fresh();
    const items = [item];
    mod.listItems.mockResolvedValue(items);
    success(await call("knowledge_list", { limit: 0 }), { items: [] });
    success(await call("knowledge_list", { limit: 5 }), { items: [item] });
    expect(items).toEqual([item]);
    expect(mod.listItems).toHaveBeenCalledTimes(2);
  });

  it("reads the item by id or slug", async () => {
    const { mod, call } = fresh();
    success(await call("knowledge_read", { idOrSlug: "ops/runbook" }), { item });
    expect(mod.get).toHaveBeenCalledExactlyOnceWith("ops/runbook");
  });

  it("returns 404 when an item does not exist", async () => {
    const { mod, call } = fresh();
    mod.get.mockResolvedValue(null);
    const response = await call("knowledge_read", { idOrSlug: "missing" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ jsonrpc: "2.0", id: 1, error: {
      code: -32000, message: 'No knowledge item "missing" in this company.', data: { code: null },
    } });
    expect(mod.get).toHaveBeenCalledExactlyOnceWith("missing");
  });

  it("forwards the backlink identifier and returns backlinks", async () => {
    const { mod, call } = fresh();
    success(await call("knowledge_backlinks", { idOrSlug: "ops/runbook" }), { backlinks: [{ id: "link-1" }] });
    expect(mod.backlinks).toHaveBeenCalledExactlyOnceWith("ops/runbook");
  });
});
