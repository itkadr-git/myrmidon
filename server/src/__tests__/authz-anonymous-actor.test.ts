import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { getAccessibleResource, hasCompanyAccess } = await import("../routes/authz.js");

describe("OPE-10599: anonymous actor on company resource routes", () => {
  const companyId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });

    const router = express.Router();
    router.get("/resource/:id", async (req, res) => {
      const resource = await getAccessibleResource(
        req as any,
        res,
        { id: req.params.id, companyId },
        "Resource not found",
      );
      if (!resource) return;
      res.json(resource);
    });
    router.get("/direct/:id", async (req, res) => {
      if (!hasCompanyAccess(req as any, companyId)) {
        res.status(404).json({ error: "Resource not found" });
        return;
      }
      res.json({ id: req.params.id, companyId });
    });
    app.use("/api", router);
    return app;
  }

  it("anonymous actor gets 401 from getAccessibleResource", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Authentication required" });
  });

  it("getAccessibleResource logs a warning with actorNoneReason for anonymous actor", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    await request(app).get("/api/resource/abc-123");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorNoneReason: expect.any(String),
        method: "GET",
        url: "/api/resource/abc-123",
      }),
      "Anonymous request to company resource; sending 401",
    );
  });

  it("getAccessibleResource surfaces the reason recorded by the middleware", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      (req as any).actorNoneReason = "no_credentials";
      next();
    });
    const router = express.Router();
    router.get("/resource/:id", async (req, res) => {
      const resource = await getAccessibleResource(
        req as any,
        res,
        { id: req.params.id, companyId },
        "Resource not found",
      );
      if (!resource) return;
      res.json(resource);
    });
    app.use("/api", router);

    await request(app).get("/api/resource/abc-123");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ actorNoneReason: "no_credentials" }),
      "Anonymous request to company resource; sending 401",
    );
  });

  it("cross-tenant agent gets 404 from getAccessibleResource", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
  });

  it("same-tenant agent gets 200 from getAccessibleResource", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const res = await request(app).get("/api/resource/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc-123", companyId });
  });

  it("anonymous actor gets 404 from direct hasCompanyAccess and is logged", async () => {
    const app = createTestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        actorNoneReason: expect.any(String),
        method: "GET",
      }),
      "Anonymous actor denied company access",
    );
  });

  it("cross-tenant agent gets 404 from direct hasCompanyAccess", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "other-company",
      source: "agent_key",
    });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Resource not found" });
  });

  it("same-tenant agent gets 200 from direct hasCompanyAccess", async () => {
    const app = createTestApp({
      type: "agent",
      agentId: "agent-1",
      companyId,
      source: "agent_key",
    });
    const res = await request(app).get("/api/direct/abc-123");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "abc-123", companyId });
  });
});
