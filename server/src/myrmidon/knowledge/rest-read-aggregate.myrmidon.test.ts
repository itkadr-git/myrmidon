import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const slug = "guide/example";
const url = `/api/myrmidon/companies/${companyId}/knowledge/items/${slug}`;
const item = { id: "item-a", slug, title: "Example", content: "Original" };
const revision = { id: "revision-a", content: "Revision A" };
const backlink = { slug: "guide/other", title: "Other" };

function setup() {
  const mod = {
    get: vi.fn(async (_slug: string): Promise<typeof item | null> => item),
    listRevisions: vi.fn(async (_slug: string) => [revision]),
    backlinks: vi.fn(async (_slug: string) => [backlink]),
  };
  const moduleFor = vi.fn(() => mod);
  const deps = { moduleFor } as unknown as KnowledgeRoutesDeps;
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board", source: "session", userId: "user-a", isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
    };
    next();
  });
  app.use("/api", knowledgeRoutes(deps));
  app.use(errorHandler);
  return { app, mod, moduleFor };
}

function expectCalls(mod: ReturnType<typeof setup>["mod"], count: number) {
  for (const port of [mod.get, mod.listRevisions, mod.backlinks]) {
    expect(port).toHaveBeenCalledTimes(count);
    expect(port).toHaveBeenCalledWith(slug);
  }
}

describe("myrmidon knowledge aggregate REST read", () => {
  it("returns the item and both nonempty port results with exact calls", async () => {
    const { app, mod, moduleFor } = setup();
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: { ...item, revisions: [revision], backlinks: [backlink] } });
    expect(moduleFor).toHaveBeenCalledExactlyOnceWith(companyId);
    expectCalls(mod, 1);
  });

  it("returns 404 without calling child ports for a missing item", async () => {
    const { app, mod } = setup();
    mod.get.mockResolvedValue(null);
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("item");
    expect(mod.get).toHaveBeenCalledExactlyOnceWith(slug);
    expect(mod.listRevisions).not.toHaveBeenCalled();
    expect(mod.backlinks).not.toHaveBeenCalled();
  });

  it.each(["listRevisions", "backlinks"] as const)("fails the whole read when %s fails", async (port) => {
    const { app, mod } = setup();
    mod[port].mockRejectedValue(new Error("port failed"));
    const res = await request(app).get(url);
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty("item");
    expectCalls(mod, 1);
  });

  it("preserves genuinely empty child results", async () => {
    const { app, mod } = setup();
    mod.listRevisions.mockResolvedValue([]);
    mod.backlinks.mockResolvedValue([]);
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: { ...item, revisions: [], backlinks: [] } });
    expectCalls(mod, 1);
  });

  it("returns 304 for an unchanged complete representation", async () => {
    const { app, mod } = setup();
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    const second = await request(app).get(url).set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(304);
    expect(second.text).toBe("");
    expectCalls(mod, 2);
  });

  it("invalidates the validator when revisions change", async () => {
    const { app, mod } = setup();
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    mod.listRevisions.mockResolvedValue([{ id: "revision-b", content: "Revision B" }]);
    const second = await request(app).get(url).set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.body).toEqual({ item: { ...item, revisions: [{ id: "revision-b", content: "Revision B" }], backlinks: [backlink] } });
    expectCalls(mod, 2);
  });

  it("invalidates the validator when backlinks change", async () => {
    const { app, mod } = setup();
    const first = await request(app).get(url);
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    mod.backlinks.mockResolvedValue([{ slug: "guide/new", title: "New" }]);
    const second = await request(app).get(url).set("If-None-Match", first.headers.etag);
    expect(second.status).toBe(200);
    expect(second.headers.etag).not.toBe(first.headers.etag);
    expect(second.body).toEqual({ item: { ...item, revisions: [revision], backlinks: [{ slug: "guide/new", title: "New" }] } });
    expectCalls(mod, 2);
  });
});
