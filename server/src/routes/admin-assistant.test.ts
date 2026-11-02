import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues } from "@myrmidon/db";
import {
  adminAssistantRoutes,
  collectClusterHealth,
  collectDryRunDiagnostics,
  DRY_RUN_PROBE_TIMEOUT_MS,
  measureDiskSpaceSafe,
} from "./admin-assistant.js";
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

/** A db mock whose select() returns a builder we can spy on for mutation calls. */
function mockDbWithMutationTracking(
  tables: {
    agents?: unknown[];
    issues?: unknown[];
    heartbeats?: unknown[];
  },
): { db: any; mutationSpies: { insert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } } {
  const mutationSpies = {
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const db = {
    ...mockDb(tables),
    ...mutationSpies,
  };
  return { db, mutationSpies };
}

/** Actor fixtures for auth tests. */
const instanceAdminAgentActor = {
  type: "agent" as const,
  agentId: "agent-1",
  companyId: "company-1",
  userEmail: null,
  source: "agent_key" as const,
  isInstanceAdmin: true,
  companyIds: ["company-1"],
  memberships: [],
};

const nonAdminAgentActor = {
  type: "agent" as const,
  agentId: "agent-1",
  companyId: "company-1",
  userEmail: null,
  source: "agent_key" as const,
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [],
};

function buildApp(actor: Record<string, unknown>, db: any) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(adminAssistantRoutes(db));
  app.use(errorHandler);
  return app;
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
      app.use((req, _res, next) => {
        req.actor = {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          userEmail: null,
          source: "agent_key",
          isInstanceAdmin: false,
          companyIds: ["company-1"],
          memberships: [],
        };
        next();
      });
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

    it("requires company access for a company-scoped request", async () => {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = {
          type: "agent",
          agentId: "agent-1",
          companyId: "other-company",
          userEmail: null,
          source: "agent_key",
          isInstanceAdmin: false,
          companyIds: ["other-company"],
          memberships: [],
        };
        next();
      });
      app.use(adminAssistantRoutes(mockDb({})));
      app.use(errorHandler);

      const res = await request(app).get("/companies/company-1/admin-assistant/cluster-health");

      expect(res.status).toBe(403);
    });

    it("requires company access for a company-scoped query request", async () => {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = {
          type: "agent",
          agentId: "agent-1",
          companyId: "other-company",
          userEmail: null,
          source: "agent_key",
          isInstanceAdmin: false,
          companyIds: ["other-company"],
          memberships: [],
        };
        next();
      });
      app.use(adminAssistantRoutes(mockDb({})));
      app.use(errorHandler);

      const res = await request(app).get(
        "/admin-assistant/cluster-health?companyId=company-1",
      );

      expect(res.status).toBe(403);
    });

    it("rejects arbitrary disk paths", async () => {
      await expect(measureDiskSpaceSafe("/etc")).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("collectDryRunDiagnostics", () => {
    it("returns an explicitly marked dry_run payload", async () => {
      const db = mockDb({
        agents: [{ status: "idle" }, { status: "running" }],
        issues: [{ status: "todo" }, { status: "done" }],
        heartbeats: [{ status: "queued" }],
      });

      const result = await collectDryRunDiagnostics(db);

      expect(result.dry_run).toBe(true);
      expect(result.timestamp).toBeDefined();
      expect(Array.isArray(result.probes)).toBe(true);
      expect(result.probes.length).toBeGreaterThan(0);
      expect(result.summary.total).toBe(result.probes.length);
      expect(result.summary.ok).toBe(result.probes.filter((p) => p.status === "ok").length);
      expect(result.summary.degraded).toBe(result.probes.filter((p) => p.status === "degraded").length);
    });

    it("never invokes mutating db methods (insert / update / delete)", async () => {
      const { db, mutationSpies } = mockDbWithMutationTracking({
        agents: [{ status: "idle" }],
        issues: [{ status: "todo" }],
        heartbeats: [{ status: "queued" }],
      });

      await collectDryRunDiagnostics(db);

      expect(mutationSpies.insert).not.toHaveBeenCalled();
      expect(mutationSpies.update).not.toHaveBeenCalled();
      expect(mutationSpies.delete).not.toHaveBeenCalled();
    });

    it("degrades a probe that exceeds its timeout but keeps the error visible and does not block siblings", async () => {
      // A probe that never resolves within the timeout window.
      const hangingDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockImplementation((_table: unknown) => {
            // Return a promise that never settles for the agents table.
            return new Promise(() => {});
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const result = await collectDryRunDiagnostics(hangingDb, { probeTimeoutMs: 30 });

      const agentsProbe = result.probes.find((p) => p.name === "agents_summary");
      expect(agentsProbe).toBeDefined();
      expect(agentsProbe!.status).toBe("degraded");
      expect(agentsProbe!.error).toBeDefined();
      expect(agentsProbe!.error).toMatch(/timed out/);

      // Other probes still completed independently.
      const diskProbe = result.probes.find((p) => p.name === "disk_usage");
      expect(diskProbe).toBeDefined();
      expect(diskProbe!.status).toBe("ok");

      // Summary counts reflect the degradation.
      expect(result.summary.degraded).toBeGreaterThan(0);
      expect(result.summary.ok).toBeGreaterThan(0);
    });

    it("degrades a probe that throws and surfaces the error message", async () => {
      const failingDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockImplementation((table: unknown) => {
            if (table === agents) {
              return rejectedQuery(new Error("connection reset"));
            }
            return queryResult([]);
          }),
        }),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      };

      const result = await collectDryRunDiagnostics(failingDb);

      const agentsProbe = result.probes.find((p) => p.name === "agents_summary");
      expect(agentsProbe).toBeDefined();
      expect(agentsProbe!.status).toBe("degraded");
      expect(agentsProbe!.error).toMatch(/connection reset/);
    });
  });

  describe("adminAssistantRoutes dry-run endpoint", () => {
    it("requires instance admin for the dry-run diagnostics route", async () => {
      const app = buildApp(nonAdminAgentActor, mockDb({}));

      const res = await request(app).get("/admin-assistant/dry-run");

      expect(res.status).toBe(403);
    });

    it("requires instance admin even when a companyId query is present", async () => {
      const app = buildApp(nonAdminAgentActor, mockDb({}));

      const res = await request(app).get("/admin-assistant/dry-run?companyId=company-1");

      expect(res.status).toBe(403);
    });

    it("returns 200 with dry_run true and redacted payload for an instance admin", async () => {
      const db = mockDb({
        agents: [{ status: "idle" }],
        issues: [{ status: "todo" }],
        heartbeats: [{ status: "queued" }],
      });
      const app = buildApp(instanceAdminAgentActor, db);

      const res = await request(app).get("/admin-assistant/dry-run");

      expect(res.status).toBe(200);
      expect(res.body.dry_run).toBe(true);
      expect(Array.isArray(res.body.probes)).toBe(true);
      expect(res.body.summary).toBeDefined();
      // No credential-shaped key should appear unredacted.
      expect(JSON.stringify(res.body)).not.toMatch(/pcp_/);
    });

    it("redacts credential-shaped values from probe detail before responding", async () => {
      // Simulate a probe that accidentally includes a credential-shaped key.
      const db = mockDb({});

      // Inject a probe whose detail carries an api_key; the route must
      // redact it before the payload leaves the process.
      const diagnostics = await collectDryRunDiagnostics(db, {
        probes: [
          {
            name: "leaky_probe",
            run: async () => ({ api_key: "pcp_secret_value_123", note: "ok" }),
          },
        ],
      });

      // Simulate what the route does: pass through redactSensitive.
      const { redactSensitive } = await import("../middleware/redact-sensitive.js");
      const redacted = redactSensitive(diagnostics) as typeof diagnostics;

      expect(JSON.stringify(redacted)).not.toContain("pcp_secret_value_123");
      expect(JSON.stringify(redacted)).toContain("[REDACTED]");
      // Non-sensitive fields survive redaction.
      const leaky = redacted.probes.find((p) => p.name === "leaky_probe");
      expect((leaky?.detail as Record<string, unknown>).note).toBe("ok");
    });
  });
});
