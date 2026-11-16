import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const url = `/api/myrmidon/companies/${companyId}/knowledge/items`;
const first = { id: "item-1", title: "First", status: "published" };
const second = { id: "item-2", title: "Second", status: "published" };

function setup(initial = [first, second]) {
  const listItems = vi.fn(async (_query: unknown) => initial);
  const moduleFor = vi.fn((_companyId: string) => ({ listItems }));
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
  const calls = (count: number, args: { kind: string | undefined; status: string; folderPrefix: string | undefined } = { kind: undefined, status: "published", folderPrefix: undefined }) => {
    expect(moduleFor).toHaveBeenCalledTimes(count);
    expect(listItems).toHaveBeenCalledTimes(count);
    for (let i = 1; i <= count; i++) {
      expect(moduleFor).toHaveBeenNthCalledWith(i, companyId);
      expect(listItems).toHaveBeenNthCalledWith(i, args);
    }
  };
  return { app, listItems, calls };
}

describe("myrmidon knowledge catalog conditional reads", () => {
  it("returns the complete catalog and a nonempty validator", async () => {
    const { app, calls } = setup();
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [first, second] });
    expect(res.headers.etag).toMatch(/^".+"$/);
    calls(1);
  });

  it("returns the same ETag for the same serialized catalog", async () => {
    const { app, calls } = setup();
    const a = await request(app).get(url);
    const b = await request(app).get(url);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ items: [first, second] });
    expect(b.headers.etag).toBe(a.headers.etag);
    expect(a.headers.etag).toMatch(/^".+"$/);
    calls(2);
  });

  it("returns 304 with an empty body for the exact validator", async () => {
    const { app, calls } = setup();
    const a = await request(app).get(url);
    const b = await request(app).get(url).set("If-None-Match", a.headers.etag);
    expect(a.body).toEqual({ items: [first, second] });
    expect(b.status).toBe(304);
    expect(b.text).toBe("");
    expect(b.headers.etag).toBe(a.headers.etag);
    calls(2);
  });

  it("returns the full catalog for an unrelated validator", async () => {
    const { app, calls } = setup();
    const res = await request(app).get(url).set("If-None-Match", '"foreign-validator"');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [first, second] });
    expect(res.headers.etag).not.toBe('"foreign-validator"');
    calls(1);
  });

  it("marks both 200 and 304 responses private with max-age 30", async () => {
    const { app, calls } = setup();
    const a = await request(app).get(url);
    const b = await request(app).get(url).set("If-None-Match", a.headers.etag);
    expect(a.status).toBe(200);
    expect(b.status).toBe(304);
    for (const res of [a, b]) {
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["cache-control"]).toMatch(/(?:^|,\s*)max-age=30(?:,|$)/);
    }
    calls(2);
  });

  it.each([
    ["title", [{ ...first, title: "Changed" }, second]],
    ["status", [{ ...first, status: "archived" }, second]],
    ["order", [second, first]],
  ])("changes the validator when %s changes and returns the new payload", async (_name, changed) => {
    const { app, listItems, calls } = setup();
    const a = await request(app).get(url);
    listItems.mockResolvedValueOnce(changed);
    const b = await request(app).get(url).set("If-None-Match", a.headers.etag);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ items: [first, second] });
    expect(b.status).toBe(200);
    expect(b.body).toEqual({ items: changed });
    expect(b.headers.etag).toMatch(/^".+"$/);
    expect(b.headers.etag).not.toBe(a.headers.etag);
    calls(2);
  });

  it("passes filters to the module and limits the returned representation", async () => {
    const { app, calls } = setup();
    const res = await request(app).get(url).query({ kind: "wiki", status: "published", space: "glossary", limit: "1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [first] });
    calls(1, { kind: "wiki", status: "published", folderPrefix: "glossary" });
  });
});
