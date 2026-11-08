import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

// Hermetic route test for GET /api/companies/:companyId/heartbeat-runs.
// The heartbeat service stays mocked (same pattern as agent-permissions-routes.test.ts),
// so the heavy heartbeat.ts module graph never loads in this suite.
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
  listVersionKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true })),
  canUser: vi.fn(async () => true),
  hasPermission: vi.fn(async () => true),
}));

const mockRunSecretRedactionRegistry = vi.hoisted(() => ({
  redactForRuns: vi.fn(async (_companyId: string, values: unknown[]) => values),
  redactForRun: vi.fn(async (_companyId: string, _runId: string, value: unknown) => value),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
  vi.doMock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mockInstanceSettingsService }));
  vi.doMock("../services/access.js", () => ({ accessService: () => mockAccessService }));
  vi.doMock("../services/run-secret-redaction.js", () => ({
    createRunSecretRedactionRegistry: () => mockRunSecretRedactionRegistry,
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null) }),
    issueService: () => ({}),
    logActivity: vi.fn(),
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
  // heartbeat.ts calls createIdleWakeBudget() at module top level; with the
  // heartbeat service mocked the module itself never loads, but the mock must
  // still expose every export other modules in the graph import.
  vi.doMock("../myrmidon/idle-pickup.js", () => ({
    findTopReadyIssueForAgent: vi.fn(),
    createIdleWakeBudget: vi.fn(() => ({
      remaining: vi.fn(() => 5),
      tryConsume: vi.fn(() => true),
    })),
  }));
  vi.doMock("../myrmidon/autonomy/gate.js", () => ({
    dbAutonomyGate: () => ({
      decide: vi.fn(async () => ({ verdict: "allowed", role: null, actionClass: "pause_wake_agents" })),
      assertAllowed: vi.fn(async () => undefined),
      holdOrAssert: vi.fn(async () => ({ verdict: "allowed", held: false })),
    }),
    autonomyGate: () => ({
      decide: vi.fn(async () => ({ verdict: "allowed", role: null, actionClass: "pause_wake_agents" })),
      assertAllowed: vi.fn(async () => undefined),
      holdOrAssert: vi.fn(async () => ({ verdict: "allowed", held: false })),
    }),
  }));
}

const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
  ]);
  return { errorHandler, agentRoutes };
});

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const { errorHandler, agentRoutes } = routeModules.value;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("company heartbeat runs list route", () => {
  const companyId = "company-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockHeartbeatService.listVersionKey.mockResolvedValue("W/\"test-version-etag\"");
    mockHeartbeatService.list.mockResolvedValue([]);
  });

  it("defaults limit to 200 and returns array without cursor when under limit", () => {
    const app = createApp();
    const mockRuns = [
      { id: "run-1", createdAt: new Date("2026-05-01T10:00:00.000Z") },
      { id: "run-2", createdAt: new Date("2026-05-01T09:00:00.000Z") },
    ];
    mockHeartbeatService.list.mockResolvedValueOnce(mockRuns);

    return request(app).get(`/api/companies/${companyId}/heartbeat-runs`).then((res) => {
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(mockHeartbeatService.list).toHaveBeenCalledWith(
        companyId,
        undefined,
        200,
        expect.objectContaining({ summary: false, before: undefined }),
      );
      expect(res.headers["x-next-cursor"]).toBeUndefined();
      expect(res.headers.etag).toBe("W/\"test-version-etag\"");
    });
  });

  it("sets X-Next-Cursor when page has exactly limit rows", () => {
    const app = createApp();
    const runs = [
      { id: "run-1", createdAt: "2026-05-01T10:00:00.000Z" },
      { id: "run-2", createdAt: "2026-05-01T09:00:00.000Z" },
    ];
    mockHeartbeatService.list.mockResolvedValueOnce(runs);

    return request(app).get(`/api/companies/${companyId}/heartbeat-runs?limit=2`).then((res) => {
      expect(res.status).toBe(200);
      expect(res.headers["x-next-cursor"]).toBe("2026-05-01T09:00:00.000Z");
    });
  });

  it("passes parsed before date to service when provided", () => {
    const app = createApp();
    mockHeartbeatService.list.mockResolvedValueOnce([]);

    return request(app)
      .get(`/api/companies/${companyId}/heartbeat-runs?limit=10&before=2026-05-01T09:00:00.000Z`)
      .then((res) => {
        expect(res.status).toBe(200);
        expect(mockHeartbeatService.list).toHaveBeenCalledWith(
          companyId,
          undefined,
          10,
          expect.objectContaining({ before: new Date("2026-05-01T09:00:00.000Z") }),
        );
        expect(mockHeartbeatService.listVersionKey).toHaveBeenCalledWith(
          companyId,
          undefined,
          10,
          false,
          expect.any(String),
          undefined,
          false,
          new Date("2026-05-01T09:00:00.000Z"),
        );
      });
  });

  it("rejects non-numeric limit with 400", () => {
    const app = createApp();
    return request(app).get(`/api/companies/${companyId}/heartbeat-runs?limit=abc`).then((res) => {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "limit must be a positive integer" });
      expect(mockHeartbeatService.list).not.toHaveBeenCalled();
    });
  });

  it("rejects zero or negative limit with 400", () => {
    const app = createApp();
    return request(app).get(`/api/companies/${companyId}/heartbeat-runs?limit=0`).then((res) => {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "limit must be a positive integer" });
    });
  });

  it("rejects invalid before parameter with 400", () => {
    const app = createApp();
    return request(app).get(`/api/companies/${companyId}/heartbeat-runs?before=not-a-date`).then((res) => {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "before must be an ISO timestamp" });
      expect(mockHeartbeatService.list).not.toHaveBeenCalled();
    });
  });

  it("returns 304 when ETag matches If-None-Match", () => {
    const app = createApp();
    return request(app)
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .set("If-None-Match", "W/\"test-version-etag\"")
      .then((res) => {
        expect(res.status).toBe(304);
        expect(mockHeartbeatService.list).not.toHaveBeenCalled();
      });
  });
});
