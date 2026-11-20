import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { lazyAiConnectionRoutes } from "./lazy-ai-connections.js";

describe("lazy AI connection routes", () => {
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
