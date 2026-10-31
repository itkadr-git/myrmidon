import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { adminAssistantRoutes, collectClusterHealth } from "./admin-assistant.js";

describe("admin assistant routes and health collection", () => {
  describe("collectClusterHealth", () => {
    it("collects and summarizes cluster metrics correctly from db", async () => {
      const now = new Date("2026-10-31T12:00:00.000Z");

      const mockDb: any = {
        select: vi.fn().mockImplementation((selectObj?: any) => {
          return {
            from: vi.fn().mockImplementation((table: any) => {
              // Agents query
              if (table && table.id && table.status && table.lastHeartbeatAt) {
                return {
                  where: vi.fn().mockResolvedValue([
                    { id: "agent-1", status: "running", lastHeartbeatAt: new Date(now.getTime() - 5000) },
                    { id: "agent-2", status: "idle", lastHeartbeatAt: new Date(now.getTime() - 10000) },
                    { id: "agent-3", status: "paused", lastHeartbeatAt: null },
                  ]),
                };
              }
              // Issues query
              if (table && table.status && !table.lastHeartbeatAt) {
                return {
                  where: vi.fn().mockResolvedValue([
                    { status: "todo" },
                    { status: "backlog" },
                    { status: "in_progress" },
                    { status: "blocked" },
                    { status: "done" },
                  ]),
                };
              }
              // Heartbeat runs query
              return {
                where: vi.fn().mockResolvedValue([{ count: 2 }]),
              };
            }),
          };
        }),
      };

      const result = await collectClusterHealth(mockDb, { companyId: "comp-1", now });

      expect(result).toBeDefined();
      expect(result.status).toBe("warning"); // blocked task > 0
      expect(result.timestamp).toBe(now.toISOString());
      expect(result.agents).toEqual({
        total: 3,
        active: 1,
        idle: 1,
        paused: 1,
        error: 0,
      });
      expect(result.tasks).toEqual({
        queued: 2, // 1 todo + 1 backlog
        inProgress: 1,
        blocked: 1,
        totalOpen: 4,
      });
      expect(result.heartbeats).toMatchObject({
        activeRuns: 2,
        maxDelayMs: 10000,
        staleCount: 0,
        status: "healthy",
      });
      expect(result.disk).toBeDefined();
      expect(typeof result.disk.totalBytes).toBe("number");
      expect(typeof result.disk.freeBytes).toBe("number");
    });

    it("marks status as critical when an agent is in error state or heartbeats are stale", async () => {
      const now = new Date("2026-10-31T12:00:00.000Z");

      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValueOnce([
              { id: "agent-err", status: "error", lastHeartbeatAt: null },
            ]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]),
          }),
        }),
      };

      const result = await collectClusterHealth(mockDb, { now });
      expect(result.status).toBe("critical");
      expect(result.agents.error).toBe(1);
    });

    it("handles database errors gracefully and returns default zero metrics", async () => {
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockRejectedValue(new Error("Database connection error")),
          }),
        }),
      };

      const result = await collectClusterHealth(mockDb);

      expect(result).toBeDefined();
      expect(result.agents.total).toBe(0);
      expect(result.tasks.totalOpen).toBe(0);
      expect(result.heartbeats.activeRuns).toBe(0);
      expect(result.disk).toBeDefined();
    });
  });

  describe("adminAssistantRoutes endpoints", () => {
    it("responds with cluster health json on GET /admin-assistant/cluster-health", async () => {
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      const app = express();
      app.use(adminAssistantRoutes(mockDb));

      const res = await request(app).get("/admin-assistant/cluster-health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("agents");
      expect(res.body).toHaveProperty("tasks");
      expect(res.body).toHaveProperty("heartbeats");
      expect(res.body).toHaveProperty("disk");
      expect(typeof res.body.agents.total).toBe("number");
      expect(typeof res.body.tasks.totalOpen).toBe("number");
      expect(typeof res.body.heartbeats.activeRuns).toBe("number");
      expect(typeof res.body.disk.freeBytes).toBe("number");
    });

    it("responds with cluster health json on GET /admin-assistant/health", async () => {
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      const app = express();
      app.use(adminAssistantRoutes(mockDb));

      const res = await request(app).get("/admin-assistant/health");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("status");
      expect(res.body).toHaveProperty("disk");
    });
  });
});
