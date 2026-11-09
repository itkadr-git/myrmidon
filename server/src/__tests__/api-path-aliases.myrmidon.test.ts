import { describe, expect, it } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { apiPathAliasMiddleware } from "../myrmidon/api-path-aliases.js";

function createTestApp() {
  const app = express();
  app.use(express.json());

  const api = Router();
  api.use(apiPathAliasMiddleware());
  api.get("/myrmidon/resource", (_req, res) => {
    res.set("X-Route-Contract", "resource-v1");
    res.status(200).json({ ok: true, method: "GET" });
  });
  api.post("/myrmidon/resource", (req, res) => {
    res.set("X-Route-Contract", "resource-v1");
    res.status(201).json({ ok: true, method: "POST", body: req.body });
  });
  app.use("/api", api);
  return app;
}

describe("apiPathAliasMiddleware", () => {
  it("serves the legacy GET path with the same response as the canonical path", async () => {
    const app = createTestApp();
    const [canonical, legacy] = await Promise.all([
      request(app).get("/api/myrmidon/resource"),
      request(app).get("/api/paperclip/resource"),
    ]);

    expect(legacy.status).toBe(canonical.status);
    expect(legacy.body).toEqual(canonical.body);
    expect(legacy.headers["x-route-contract"]).toBe(
      canonical.headers["x-route-contract"],
    );
  });

  it("serves the legacy POST path with the same response and headers", async () => {
    const app = createTestApp();
    const payload = { name: "alias" };
    const [canonical, legacy] = await Promise.all([
      request(app).post("/api/myrmidon/resource?trace=1").send(payload),
      request(app).post("/api/paperclip/resource?trace=1").send(payload),
    ]);

    expect(legacy.status).toBe(canonical.status);
    expect(legacy.body).toEqual(canonical.body);
    expect(legacy.headers["x-route-contract"]).toBe(
      canonical.headers["x-route-contract"],
    );
  });

  it("does not rewrite a path with only a paperclip prefix", async () => {
    const app = createTestApp();
    const response = await request(app).get("/api/paperclip-old/resource");

    expect(response.status).toBe(404);
  });
});
