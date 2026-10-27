import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler, type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import { blockerGraphRootsResponseSchema } from "@myrmidon/shared";
import type { BlockerEdge } from "../services/blocker-graph/root-fanout.js";

const mocks = vi.hoisted(() => ({ decide: vi.fn(), load: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => ({ decide: mocks.decide }) }));
vi.mock("../services/blocker-graph/load-edges.js", () => ({ loadBlockedGraph: mocks.load }));
import { blockerGraphRoutes } from "../routes/blocker-graph.js";

const companyId = randomUUID();
const rootId = randomUUID();
const smallerRootId = randomUUID();
const edges: BlockerEdge[] = [
  { blockedId: randomUUID(), blockerId: smallerRootId, blockerStatus: "todo" },
  ...Array.from({ length: 20 }, () => ({
    blockedId: randomUUID(), blockerId: rootId, blockerStatus: "in_progress",
  })),
];
const db = {} as Db;
const loadGraph = vi.fn();
function app(actor?: Request["actor"], production = false) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor ?? { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" };
    next();
  });
  app.use("/api", blockerGraphRoutes(db, production ? {} : { loadGraph }));
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  };
  app.use(errors);
  return app;
}
const url = `/api/companies/${companyId}/blocker-graph/roots`;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.decide.mockResolvedValue({ allowed: true });
  loadGraph.mockResolvedValue({ edges, blockedIssues: [] });
  mocks.load.mockResolvedValue({ edges, blockedIssues: [] });
});

describe("blocker graph roots routes", () => {
  it("returns the root holding 20 issues first and validates the shared response", async () => {
    const response = await request(app()).get(url);
    expect(response.status).toBe(200);
    expect(blockerGraphRootsResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.roots.map((root: { dependentCount: number }) => root.dependentCount)).toEqual([20, 1]);
    expect(response.body.roots[0].rootIssueId).toBe(rootId);
    expect(response.body.roots[0].dependents).toHaveLength(20);
    expect(loadGraph).toHaveBeenCalledWith(db, companyId);
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read", resource: { type: "company", companyId },
    }));
  });

  it("respects limit after sorting, not before", async () => {
    const response = await request(app()).get(`${url}?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.limit).toBe(1);
    expect(response.body.roots).toHaveLength(1);
    expect(response.body.roots[0].rootIssueId).toBe(rootId);
  });

  it("rejects a foreign company before loading its graph", async () => {
    const response = await request(app()).get(`/api/companies/${randomUUID()}/blocker-graph/roots`);
    expect(response.status).toBe(403);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("rejects board actors outside the company", async () => {
    const response = await request(app({ type: "board", companyIds: [randomUUID()], source: "session" })).get(url);
    expect(response.status).toBe(403);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("rejects scoped actors denied company-wide read", async () => {
    mocks.decide.mockResolvedValue({ allowed: false });
    expect((await request(app()).get(url)).status).toBe(403);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("rejects task bridge keys even in their company", async () => {
    const response = await request(app({ type: "agent", agentId: randomUUID(), companyId,
      source: "agent_key", keyScope: { kind: "task_bridge", issueId: randomUUID() } } as Request["actor"])).get(url);
    expect(response.status).toBe(403);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "abc", "9007199254740992", "1&limit=2", ""]) (
    "rejects invalid limit %s", async (limit) => {
      expect((await request(app()).get(`${url}?limit=${limit}`)).status).toBe(400);
      expect(loadGraph).not.toHaveBeenCalled();
    },
  );

  it("returns an empty valid envelope for an empty graph", async () => {
    loadGraph.mockResolvedValue({ edges: [], blockedIssues: [] });
    const response = await request(app()).get(url);
    expect(response.status).toBe(200);
    expect(response.body.roots).toEqual([]);
    expect(blockerGraphRootsResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("validates computed roots before sending a response", async () => {
    loadGraph.mockResolvedValue({ edges: [{ blockedId: "invalid", blockerId: "invalid", blockerStatus: "todo" },
      { blockedId: randomUUID(), blockerId: "invalid", blockerStatus: "todo" }], blockedIssues: [] });
    expect((await request(app()).get(url)).status).toBe(500);
  });

  it("wires the production default to the OPE-9162 loader", async () => {
    expect((await request(app(undefined, true)).get(url)).status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith(db, companyId);
  });
});
