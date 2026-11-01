import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { maintenanceRoutes } from "./routes.js";
import type { Db } from "@myrmidon/db";
import type { MaintenanceService } from "./service.js";

function createApp() {
  const app = express();
  app.use(express.json());
  // Fake board-member actor for assertBoardOrgAccess (same shape as real auth middleware)
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "instance-admin-1",
      source: "local_implicit",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
    } as unknown as Express.Request["actor"];
    next();
  });
  const mockService = {
    status: async () => ({ active: false, instance: null, windows: [] }),
    enter: async () => ({ id: "w-1" }),
    exit: async () => ({ id: "w-1" }),
  } as unknown as MaintenanceService;

  app.use("/api", maintenanceRoutes({} as Db, mockService));
  app.use(errorHandler);
  return app;
}

describe("maintenance window cron validator routes", () => {
  const app = createApp();

  describe("POST /api/myrmidon/maintenance/validate-cron", () => {
    it("validates a correct weekly cron expression", async () => {
      const res = await request(app)
        .post("/api/myrmidon/maintenance/validate-cron")
        .send({
          cron: "0 3 * * 0",
          durationMinutes: 120,
          timezone: "UTC",
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.cron).toBe("0 3 * * 0");
      expect(res.body.durationMinutes).toBe(120);
      expect(res.body.timezone).toBe("UTC");
      expect(res.body.description).toContain("Sunday");
      expect(Array.isArray(res.body.nextRuns)).toBe(true);
      expect(res.body.nextRuns.length).toBeGreaterThan(0);
      expect(res.body.nextRuns[0]).toHaveProperty("startsAt");
      expect(res.body.nextRuns[0]).toHaveProperty("endsAt");
    });

    it("returns validation failure for an invalid cron expression", async () => {
      const res = await request(app)
        .post("/api/myrmidon/maintenance/validate-cron")
        .send({
          cron: "65 3 * * 0",
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toContain("out of allowed bounds");
      expect(res.body.field).toBe("minute");
    });

    it("returns 400 for missing or empty cron body", async () => {
      const res = await request(app)
        .post("/api/myrmidon/maintenance/validate-cron")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns validation failure for out-of-range duration", async () => {
      const res = await request(app)
        .post("/api/myrmidon/maintenance/validate-cron")
        .send({
          cron: "0 3 * * 0",
          durationMinutes: 2000,
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toContain("must not exceed 1440 minutes");
      expect(res.body.field).toBe("durationMinutes");
    });
  });

  describe("POST /api/myrmidon/auto-update/validate-cron", () => {
    it("validates successfully via the auto-update route alias", async () => {
      const res = await request(app)
        .post("/api/myrmidon/auto-update/validate-cron")
        .send({
          cron: "30 2 * * 1-5",
          durationMinutes: 60,
        });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.description).toContain("Monday through Friday");
      expect(res.body.durationMinutes).toBe(60);
    });
  });
});
