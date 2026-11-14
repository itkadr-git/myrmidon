import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentService } from "../services/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  status: "idle",
  permissions: { canCreateAgents: false },
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  createApiKey: vi.fn(),
  listKeys: vi.fn(),
  listApiKeys: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
  authenticateApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  logActivity: mockLogActivity,
  accessService: () => ({}),
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  secretService: () => ({}),
  workspaceOperationService: () => ({}),
  agentInstructionsService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../myrmidon/autonomy/gate.js", () => ({
  dbAutonomyGate: () => ({
    decide: async () => ({ verdict: "allowed" }),
    assertAllowed: async () => ({ verdict: "allowed" }),
    holdOrAssert: async () => ({ verdict: "allowed", held: false }),
  }),
}));

async function createApp(actor: Record<string, unknown>) {
  const { agentRoutes } = await import("../routes/agents.js");
  const { errorHandler } = await import("../middleware/index.js");
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

describe("agent API keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
  });

  it("creates and lists agent API keys", async () => {
    const expiresAt = new Date("2026-12-31T23:59:59.000Z");
    mockAgentService.createApiKey.mockResolvedValue({
      id: keyId,
      agentId,
      companyId,
      name: "worker-key",
      token: "pcp_agent_secret_token",
      scope: { kind: "standard" },
      responsibleUserId: "user-1",
      expiresAt,
      createdAt: new Date("2026-11-14T00:00:00.000Z"),
    });

    mockAgentService.listKeys.mockResolvedValue([
      {
        id: keyId,
        name: "worker-key",
        scope: { kind: "standard" },
        responsibleUserId: "user-1",
        expiresAt,
        createdAt: new Date("2026-11-14T00:00:00.000Z"),
        revokedAt: null,
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/agents/${agentId}/keys`)
      .send({
        name: "worker-key",
        expiresAt: expiresAt.toISOString(),
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body).toMatchObject({
      id: keyId,
      name: "worker-key",
      expiresAt: expiresAt.toISOString(),
    });
    expect(mockAgentService.createApiKey).toHaveBeenCalledWith(
      agentId,
      "worker-key",
      { kind: "standard" },
      expect.objectContaining({
        responsibleUserId: "user-1",
        expiresAt: expect.any(Date),
      }),
    );

    const listRes = await request(app).get(`/api/agents/${agentId}/keys`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0]).toMatchObject({
      id: keyId,
      name: "worker-key",
      expiresAt: expiresAt.toISOString(),
    });
  });

  it("creates agent API key without expiresAt (null)", async () => {
    mockAgentService.createApiKey.mockResolvedValue({
      id: keyId,
      agentId,
      companyId,
      name: "permanent-key",
      token: "pcp_agent_secret_token",
      scope: { kind: "standard" },
      responsibleUserId: "user-1",
      expiresAt: null,
      createdAt: new Date("2026-11-14T00:00:00.000Z"),
    });

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "permanent-key" });

    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeNull();
  });

  describe("authenticateApiKey service logic", () => {
    it("authenticates valid key when expiresAt is in the future", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([
              {
                id: keyId,
                agentId,
                companyId,
                keyHash: "dummy-hash",
                expiresAt: new Date(Date.now() + 60000),
                revokedAt: null,
              },
            ]),
          }),
        }),
      } as any;

      const svc = agentService(mockDb);
      const res = await svc.authenticateApiKey("test-token");
      expect(res).not.toBeNull();
      expect(res?.id).toBe(keyId);
    });

    it("authenticates valid key when expiresAt is null (no expiration)", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([
              {
                id: keyId,
                agentId,
                companyId,
                keyHash: "dummy-hash",
                expiresAt: null,
                revokedAt: null,
              },
            ]),
          }),
        }),
      } as any;

      const svc = agentService(mockDb);
      const res = await svc.authenticateApiKey("test-token");
      expect(res).not.toBeNull();
      expect(res?.id).toBe(keyId);
    });

    it("rejects key when expiresAt is in the past", async () => {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([
              {
                id: keyId,
                agentId,
                companyId,
                keyHash: "dummy-hash",
                expiresAt: new Date(Date.now() - 60000),
                revokedAt: null,
              },
            ]),
          }),
        }),
      } as any;

      const svc = agentService(mockDb);
      const res = await svc.authenticateApiKey("test-token");
      expect(res).toBeNull();
    });
  });
});
