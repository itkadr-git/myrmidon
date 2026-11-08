import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { updatesRoutes } from "./updates.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "instance-admin-1",
      source: "local_implicit",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", updatesRoutes());
  app.use(errorHandler);
  return app;
}

describe("updates routes (OPE-10268)", () => {
  it("GET /api/updates/settings returns default settings with UTC timezone", async () => {
    const app = createApp();
    const res = await request(app).get("/api/updates/settings");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("mode");
    expect(res.body.window?.timezone).toBe("UTC");
    expect(res.body.window).toHaveProperty("days");
    expect(res.body.canary).toHaveProperty("enabled");
    expect(res.body.autoRollback).toHaveProperty("enabled");
  });

  it("PUT /api/updates/settings saves and returns valid settings", async () => {
    const app = createApp();
    const payload = {
      mode: "auto",
      window: {
        enabled: true,
        days: [1, 2, 3, 4, 5],
        fromMinute: 120,
        toMinute: 300,
        timezone: "Europe/Berlin",
      },
      canary: {
        enabled: true,
        sharePercent: 25,
        minBots: 2,
        maxBots: 6,
        healthSettleSec: 600,
      },
      autoRollback: {
        enabled: true,
        failureThresholdPercent: 15,
        healthTimeoutMinutes: 30,
      },
    };

    const putRes = await request(app).put("/api/updates/settings").send(payload);
    expect(putRes.status).toBe(200);
    expect(putRes.body.mode).toBe("auto");
    expect(putRes.body.window.timezone).toBe("Europe/Berlin");
    expect(putRes.body.window.fromMinute).toBe(120);
    expect(putRes.body.window.toMinute).toBe(300);
    expect(putRes.body.canary.sharePercent).toBe(25);
    expect(putRes.body.autoRollback.failureThresholdPercent).toBe(15);

    // Verify round-trip persistence
    const getRes = await request(app).get("/api/updates/settings");
    expect(getRes.status).toBe(200);
    expect(getRes.body.window.timezone).toBe("Europe/Berlin");
    expect(getRes.body.canary.sharePercent).toBe(25);
    expect(getRes.body.autoRollback.failureThresholdPercent).toBe(15);
  });

  describe("validation failures (400)", () => {
    it("returns 400 for out-of-bounds window intervals", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          window: {
            fromMinute: -5,
            toMinute: 1500,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("fromMinute"))).toBe(true);
      expect(paths.some((p) => p.includes("toMinute"))).toBe(true);
    });

    it("returns 400 for durationMinutes out of bounds (< 5 or > 1440)", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          window: {
            durationMinutes: 2000,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("durationMinutes"))).toBe(true);
    });

    it("returns 400 for invalid timezone", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          window: {
            timezone: "Invalid/NonExistent_Zone",
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("timezone"))).toBe(true);
    });

    it("returns 400 for invalid canary percentage (> 100 or < 0)", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          canary: {
            sharePercent: 150,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("sharePercent"))).toBe(true);
    });

    it("returns 400 when canary maxBots < minBots", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          canary: {
            minBots: 10,
            maxBots: 2,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("maxBots"))).toBe(true);
    });

    it("returns 400 for invalid auto-rollback percentage (> 100 or < 0)", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          autoRollback: {
            failureThresholdPercent: -1,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("failureThresholdPercent"))).toBe(true);
    });

    it("returns 400 for invalid auto-rollback timeout (< 1 or > 1440 minutes)", async () => {
      const app = createApp();
      const res = await request(app)
        .put("/api/updates/settings")
        .send({
          autoRollback: {
            healthTimeoutMinutes: 0,
          },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
      const paths = (res.body.details as any[]).map((d) => d.path.join("."));
      expect(paths.some((p) => p.includes("healthTimeoutMinutes"))).toBe(true);
    });
  });

  describe("aliases and utilities", () => {
    it("PATCH /api/updates/settings partially updates settings", async () => {
      const app = createApp();
      const patchRes = await request(app)
        .patch("/api/updates/settings")
        .send({
          mode: "auto_release",
          canary: {
            sharePercent: 40,
          },
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.mode).toBe("auto_release");
      expect(patchRes.body.canary.sharePercent).toBe(40);
    });

    it("supports /api/updates alias", async () => {
      const app = createApp();
      const res = await request(app).get("/api/updates");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("mode");
    });

    it("POST /api/updates/validate validates input without persisting", async () => {
      const app = createApp();
      const validRes = await request(app)
        .post("/api/updates/validate")
        .send({
          mode: "auto",
          window: {
            timezone: "UTC",
          },
        });

      expect(validRes.status).toBe(200);
      expect(validRes.body.valid).toBe(true);

      const invalidRes = await request(app)
        .post("/api/updates/validate")
        .send({
          canary: {
            sharePercent: 200,
          },
        });

      expect(invalidRes.status).toBe(400);
    });
  });
});
