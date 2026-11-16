import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { knowledgeRoutes, type KnowledgeRoutesDeps } from "./routes.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const url = `/api/myrmidon/companies/${companyId}/knowledge/items`;
const actor = {
  type: "board", source: "session", userId: "user-a", isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, status: "active", membershipRole: "operator" }],
};

function setup(items: { id: string }[] = [{ id: "first" }, { id: "second" }, { id: "third" }]) {
  const listItems = vi.fn(async () => items);
  const moduleFor = vi.fn(() => ({ listItems }));
  const deps = { moduleFor } as unknown as KnowledgeRoutesDeps;
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", knowledgeRoutes(deps));
  app.use(errorHandler);
  return { app, listItems, moduleFor, items };
}

describe("myrmidon knowledge catalogue REST filters", () => {
  it("defaults to published and returns the port result", async () => {
    const { app, listItems, moduleFor } = setup();
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: "first" }, { id: "second" }, { id: "third" }]);
    expect(moduleFor).toHaveBeenCalledTimes(1);
    expect(moduleFor).toHaveBeenCalledWith(companyId);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: undefined, status: "published", folderPrefix: undefined });
  });

  it.each(["draft", "archived", "superseded"])("passes explicit %s status", async (status) => {
    const { app, listItems } = setup([{ id: status }]);
    const res = await request(app).get(url).query({ status });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: status }]);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: undefined, status, folderPrefix: undefined });
  });

  it("maps kind and space to the port filters", async () => {
    const { app, listItems } = setup([{ id: "filtered" }]);
    const res = await request(app).get(url).query({ kind: "wiki", space: "guides/team", status: "draft" });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: "filtered" }]);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: "wiki", status: "draft", folderPrefix: "guides/team" });
  });

  it("does not truncate a catalogue without a limit", async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i}` }));
    const { app, listItems } = setup(items);
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(items);
    expect(res.body.items).toHaveLength(30);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: undefined, status: "published", folderPrefix: undefined });
  });

  it("returns the first two items without changing the port array", async () => {
    const { app, listItems, items } = setup();
    const res = await request(app).get(url).query({ limit: 2 });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: "first" }, { id: "second" }]);
    expect(items).toEqual([{ id: "first" }, { id: "second" }, { id: "third" }]);
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ kind: undefined, status: "published", folderPrefix: undefined });
  });

  it.each([{ status: "unknown" }, { kind: "unknown" }, { limit: 0 }, { limit: "abc" }])(
    "rejects invalid query %j before calling the port", async (query) => {
      const { app, listItems, moduleFor } = setup();
      const res = await request(app).get(url).query(query);
      expect(res.status).toBe(400);
      expect(listItems).not.toHaveBeenCalled();
      expect(moduleFor).not.toHaveBeenCalled();
    },
  );
});
