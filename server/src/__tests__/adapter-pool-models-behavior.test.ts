import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { ServerAdapter } from "../adapters/index.js";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(() => true),
  hasPermission: vi.fn(() => true),
  decide: vi.fn(() => ({ allowed: true })),
  requireCompanyAdmin: vi.fn(),
  requirePermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  getByName: vi.fn(async (_companyId: string, name: string) => ({ id: `sec-${name}` })),
  resolveSecretValue: vi.fn(async () => "mock-pool-api-key"),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

const poolTestAdapterType = "pool_behavior_test_adapter";

const mockProviderRow = {
  id: "prov-pool-1",
  companyId: "company-1",
  type: "chatgpt-pool",
  name: "ChatGPT Codex Pool",
  baseUrl: "http://pool.local",
  credentialSecretName: "pool-sec",
  free: false,
  hasKey: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function createApp(dbMock?: any) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });

  const defaultDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [mockProviderRow]),
      })),
    })),
  };

  app.use("/api", agentRoutes((dbMock ?? defaultDb) as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function registerTestAdapter(adapter: ServerAdapter) {
  const { registerServerAdapter } = await import("../adapters/index.js");
  registerServerAdapter(adapter);
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("pool models behavior tests (1.6.6 OPE-9932)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    registerModuleMocks();
    originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({
            accounts: [
              {
                account_number: 1,
                email: "active@example.com",
                label: "ChatGPT Plus #1",
                status: "active",
                models: ["gpt-4o", "pool-only-model"],
              },
              {
                account_number: 2,
                email: "banned@example.com",
                label: "Banned Account #2",
                status: "banned",
                models: ["gpt-4o", "banned-only-model"],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    await registerTestAdapter({
      type: poolTestAdapterType,
      label: "Pool Behavior Test Adapter",
      models: [
        { id: "base-adapter-model", label: "Base Adapter Model" },
        { id: "gpt-4o", label: "GPT-4o (Base)" },
      ],
      validateConfig: () => null,
      execute: async () => ({ exitCode: 0 }),
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await unregisterTestAdapter(poolTestAdapterType);
    vi.restoreAllMocks();
  });

  it("(a) GET /adapters/:type/models enriches pool models with non-banned accounts and excludes banned-only models", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/adapters/${poolTestAdapterType}/models`),
    );

    expect(res.status).toBe(200);
    const models = res.body;
    expect(Array.isArray(models)).toBe(true);

    // 1. Base model not present in pool remains without accounts
    const baseModel = models.find((m: any) => m.id === "base-adapter-model");
    expect(baseModel).toBeDefined();
    expect(baseModel.accounts).toBeUndefined();

    // 2. Shared model is enriched with active account and NOT banned account
    const sharedModel = models.find((m: any) => m.id === "gpt-4o");
    expect(sharedModel).toBeDefined();
    expect(sharedModel.accounts).toEqual(["ChatGPT Plus #1"]);

    // 3. Pool-only model from active account is appended with supplier accounts
    const poolOnlyModel = models.find((m: any) => m.id === "pool-only-model");
    expect(poolOnlyModel).toBeDefined();
    expect(poolOnlyModel.accounts).toEqual(["ChatGPT Plus #1"]);

    // 4. Model provided only by banned account is completely excluded
    const bannedOnlyModel = models.find((m: any) => m.id === "banned-only-model");
    expect(bannedOnlyModel).toBeUndefined();
  });

  it("(b) PATCH /api/agents/:id accepts saving bot configuration with a pool model and rejects unknown/banned-only models", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId: "company-1",
      name: "Pool Bot",
      urlKey: "pool-bot",
      role: "engineer",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: poolTestAdapterType,
      adapterConfig: { model: "base-adapter-model" },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    mockAgentService.update.mockImplementation(async (_id: string, patch: any) => ({
      id: agentId,
      companyId: "company-1",
      adapterType: poolTestAdapterType,
      adapterConfig: patch.adapterConfig,
    }));

    const app = await createApp();

    // 1. Updating with pool-only model succeeds (200)
    const successRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: { model: "pool-only-model" },
        }),
    );
    expect(successRes.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ model: "pool-only-model" }),
      }),
    );

    mockAgentService.update.mockClear();

    // 2. Updating with model provided only by banned accounts is rejected (422)
    const bannedRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: { model: "banned-only-model" },
        }),
    );
    expect(bannedRes.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();

    // 3. Updating with a completely unknown model is rejected (422)
    const unknownRes = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: { model: "completely-nonexistent-model" },
        }),
    );
    expect(unknownRes.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
