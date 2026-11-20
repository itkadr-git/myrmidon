import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { lazyAiConnectionRoutes } from "./lazy-ai-connections.js";

describe("lazy AI connection routes", () => {
  it("initializes the router only once for concurrent first requests", async () => {
    const app = express();
    const router = express.Router();
    router.get("/companies/:id/ai-connections", (_req, res) => res.sendStatus(204));
    let loads = 0;
    app.use("/api", lazyAiConnectionRoutes(async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return router;
    }));
    const responses = await Promise.all([
      request(app).get("/api/companies/a/ai-connections"),
      request(app).get("/api/companies/b/ai-connections"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([204, 204]);
    expect(loads).toBe(1);
  });

  it("matches the same case-insensitive paths as the Express router", async () => {
    const app = express();
    const router = express.Router();
    router.get("/companies/:id/ai-connections", (_req, res) => res.json({ ok: true }));
    app.use("/api", lazyAiConnectionRoutes(async () => router));
    for (const path of ["/api/companies/test/ai-connections", "/api/companies/test/AI-CONNECTIONS"]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    }
  });
});
