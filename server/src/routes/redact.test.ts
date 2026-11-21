import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../middleware/error-handler.js";
import { redactRoutes } from "./redact.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  // Bypass auth for tests: mock middleware sets the actor the route expects.
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["c0000000-0000-0000-0000-000000000001"],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", redactRoutes(null as any));
  app.use(errorHandler);
  return app;
}

const validConfig = {
  version: "1.7.0",
  updatedAt: "2026-11-02T00:00:00.000Z",
  rules: [
    {
      id: "r1",
      name: "Secrets",
      mode: "mask",
      maskStyle: "reversible",
      ttlSeconds: 7200,
      recognizers: [{ kind: "secret", enabled: true }],
    },
  ],
};

describe("redact routes", () => {
  describe("GET /api/redact/config", () => {
    it("returns normalized config", async () => {
      const res = await request(buildApp()).get("/api/redact/config");
      expect(res.status).toBe(200);
      expect(res.body.version).toBe("1.7.0");
      expect(Array.isArray(res.body.rules)).toBe(true);
      expect(res.body.rules[0]).toHaveProperty("mode", "mask");
      expect(res.body.rules[0]).toHaveProperty("maskStyle", "irreversible");
    });

    it("returns strict schema (no extra fields)", async () => {
      const res = await request(buildApp()).get("/api/redact/config");
      const keys = Object.keys(res.body);
      expect(keys.sort()).toEqual(["rules", "updatedAt", "version"]);
    });
  });

  describe("POST /api/redact/validate", () => {
    it("accepts valid config and returns normalized", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send(validConfig);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.errors).toEqual([]);
      expect(res.body.normalized.rules[0].ttlSeconds).toBe(7200);
      expect(res.body.normalized.rules[0].mode).toBe("mask");
    });

    it("rejects unknown top-level fields", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({ ...validConfig, extraField: true });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.normalized).toBeNull();
    });

    it("rejects unknown nested fields", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({
          ...validConfig,
          rules: [
            {
              ...validConfig.rules[0],
              secret: "pcp_abc123",
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("rejects invalid mode", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], mode: "unknown" }],
        });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("rejects invalid maskStyle", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({
          ...validConfig,
          rules: [{ ...validConfig.rules[0], maskStyle: "both" }],
        });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("rejects empty rules array", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({ ...validConfig, rules: [] });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("rejects non-ISO updatedAt", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({ ...validConfig, updatedAt: "not-a-date" });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("rejects secrets embedded in config", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({
          ...validConfig,
          rules: [
            {
              ...validConfig.rules[0],
              recognizers: [
                { kind: "secret", enabled: true, apiKey: "dummy-test-key-not-a-real-secret" },
              ],
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.valid).toBe(false);
    });

    it("normalizes defaults on valid config", async () => {
      const res = await request(buildApp())
        .post("/api/redact/validate")
        .send({
          version: "1.7.0",
          updatedAt: "2026-11-02T00:00:00.000Z",
          rules: [
            {
              id: "r2",
              name: "PII flag",
              recognizers: [{ kind: "pii" }],
            },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.normalized.rules[0].mode).toBe("flag");
      expect(res.body.normalized.rules[0].maskStyle).toBe("irreversible");
      expect(res.body.normalized.rules[0].ttlSeconds).toBe(3600);
      expect(res.body.normalized.rules[0].recognizers[0].enabled).toBe(true);
      expect(res.body.normalized.rules[0].recognizers[0].priority).toBe(100);
    });
  });
});
