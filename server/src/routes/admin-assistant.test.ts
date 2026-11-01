import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@myrmidon/db";
import { adminAssistantRoutes, collectClusterHealth, measureDiskSpaceSafe } from "./admin-assistant.js";
import { errorHandler } from "../middleware/error-handler.js";

/**
 * Builds a mock drizzle query result that supports both
 * `await builder` (agents query without company filter) and
 * `await builder.where(...)` (filtered queries).
 */
function queryResult(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return Object.assign(promise, {
    where: vi.fn().mockResolvedValue(rows),
  });
}

function rejectedQuery(error: Error) {
  const promise = Promise.reject(error);
  // Mark the base promise as handled: filtered paths only await `.where()`.
  promise.catch(() => {});
  return Object.assign(promise, {
    where: vi.fn().mockRejectedValue(error),
  });
}

function mockDb(
  tables: {
    agents?: unknown[];
    issues?: unknown[];
    heartbeats?: unknown[];
  },
  error?: Error,
): any {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation((table: unknown) => {
        if (error) {
          return rejectedQuery(error);
        }
        if (table === agents) {
          return queryResult(tables.agents ?? []);
        }
        if (table === issues) {
          return queryResult(tables.issues ?? []);
        }
        if (table === heartbeatRuns) {
          return queryResult(tables.heartbeats ?? []);
        }
        return queryResult([]);
      }),
    }),
  };
}

describe("admin assistant routes and health collection", () => {
  describe("collectClusterHealth", () => {
    it("collects and summarizes cluster metrics correctly from db", async () => {
      const now = new Date("2026-10-31T12:00:00.000Z");

      const db = mockDb({
        agents: [
          { id: "agent-1", status: "running", lastHeartbeatAt: new Date(now.getTime() - 5000) },
          { id: "agent-2", status: "idle", lastHeartbeatAt: new Date(now.getTime() - 10000) },
          { id: "agent-3", status: "paused", lastHeartbeatAt: null },
        ],
        issues: [
          { status: "todo" },
          { status: "backlog" },
          { status: "in_progress" },
          { status: "blocked" },
          { status: "done" },
        ],
        heartbeats: [{ count: 2 }],
      });

      const result = await collectClusterHealth(db, { companyId: "comp-1", now });

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

      const db = mockDb({
        agents: [{ id: "agent-err", status: "error", lastHeartbeatAt: null }],
        issues: [],
        heartbeats: [{ count: 0 }],
      });

      const result = await collectClusterHealth(db, { now });
      expect(result.status).toBe("critical");
      expect(result.agents.error).toBe(1);
    });

    it("handles database errors gracefully and returns default zero metrics", async () => {
      const db = mockDb({}, new Error("Database connection error"));

      const result = await collectClusterHealth(db);

      expect(result).toBeDefined();
      expect(result.agents.total).toBe(0);
      expect(result.tasks.totalOpen).toBe(0);
      expect(result.heartbeats.activeRuns).toBe(0);
      expect(result.disk).toBeDefined();
    });
  });

  describe("adminAssistantRoutes endpoints", () => {
    it("requires instance admin for unscoped cluster health", async () => {
      const app = express();
      app.use(adminAssistantRoutes(mockDb({})));
      app.use(errorHandler);

      const res = await request(app).get("/admin-assistant/cluster-health");

      expect(res.status).toBe(403);
    });

    it("requires instance admin for unscoped health routes", async () => {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          userId: "user-1",
          userEmail: null,
          source: "session",
          isInstanceAdmin: false,
          companyIds: [],
          memberships: [],
        };
        next();
      });
      app.use(adminAssistantRoutes(mockDb({})));
      app.use(errorHandler);

      const res = await request(app).get("/admin-assistant/health");

      expect(res.status).toBe(403);
    });

    it("preserves health collection for a company-scoped request", async () => {
      const app = express();
      app.use(adminAssistantRoutes(mockDb({})));
      app.use(errorHandler);

      const res = await request(app).get("/companies/company-1/admin-assistant/cluster-health");

      expect(res.status).not.toBe(500);
    });

    it("rejects arbitrary disk paths", async () => {
      await expect(measureDiskSpaceSafe("/etc")).rejects.toMatchObject({ status: 400 });
    });
  });
});
