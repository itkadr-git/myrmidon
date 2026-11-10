// agents.bulk-update-model.test.ts
//
// Tests for the 1.7 FLEET-OPS-BULK-API bulk model/connection update route
// (OPE-12224). Covers partial success (valid agents updated, invalid ones
// reported in failed[] with a reason), idempotency on repeated calls, and
// activity-log emission per mutation.
//
// The invalid-model test exercises the real production validation path
// (assertMyrmidonAgentConfigChange → assertAgentModelsKnown against the
// adapter's static model list), not a mocked svc.update throw.

import { describe, it, beforeEach, vi, expect } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@myrmidon/db";
import { HttpError } from "../errors.js";
import { agentRoutes } from "./agents.js";

const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const AGENT_1 = "22222222-2222-4333-8444-555555555555";
const AGENT_2 = "33333333-2222-4333-8444-555555555555";
const AGENT_3 = "44444444-2222-4333-8444-555555555555";

// claude_local static model list (packages/adapters/claude-local/src/index.ts).
const VALID_MODEL = "claude-opus-4-6";
const INVALID_MODEL = "claude-3-opus";

const CONNECTION_ID = "55555555-2222-4333-8444-555555555555";
const GRANT_ID = "66666666-2222-4333-8444-555555555555";

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: COMPANY_ID,
    name: `Agent ${id}`,
    role: "engineer",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-sonnet-4-5" },
    runtimeConfig: {},
    ...overrides,
  };
}

const agentSvcMock = {
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  orgForCompany: vi.fn(),
  resolveByReference: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  updatePermissions: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
};

const instructionsSvcMock = {
  getBundle: vi.fn(),
  updateBundle: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  materializeManagedBundle: vi.fn(),
};

const logActivityMock = vi.fn();

vi.mock("../services/index.js", () => ({
  agentService: vi.fn(() => agentSvcMock),
  agentInstructionsService: vi.fn(() => instructionsSvcMock),
  accessService: vi.fn(() => ({
    decide: vi.fn(async () => ({ allowed: true, reason: "allow", explanation: "" })),
    hasPermission: vi.fn(async () => true),
    canUser: vi.fn(async () => true),
    listPrincipalGrants: vi.fn(async () => []),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
    getMembership: vi.fn(),
  })),
  changeConsentGateService: vi.fn(() => ({
    assertConsented: vi.fn(async () => {}),
  })),
  approvalService: vi.fn(() => ({
    create: vi.fn(),
    listForIssue: vi.fn(),
    decide: vi.fn(),
  })),
  builtInAgentService: vi.fn(() => ({
    list: vi.fn(),
    get: vi.fn(),
  })),
  companySkillService: vi.fn(() => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillEntries: vi.fn(),
  })),
  budgetService: vi.fn(() => ({
    listForCompany: vi.fn(),
    getForAgent: vi.fn(),
    setForAgent: vi.fn(),
  })),
  heartbeatService: vi.fn(() => ({})),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: vi.fn(() => ({})),
  issueRecoveryActionService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({ addComment: vi.fn(), update: vi.fn() })),
  logActivity: logActivityMock,
  syncInstructionsBundleConfigFromFilePath: vi.fn(async (x: unknown) => x),
  workspaceOperationService: vi.fn(() => ({})),
}));

vi.mock("../myrmidon/agent-instructions-revisions/service.js", () => ({
  recordAgentInstructionsRevision: vi.fn(),
  listAgentInstructionsRevisions: vi.fn(() => []),
  getAgentInstructionsRevision: vi.fn(),
  toRecord: vi.fn((x: unknown) => x),
}));

vi.mock("../myrmidon/autonomy/gate.js", () => ({
  dbAutonomyGate: vi.fn(() => ({
    decide: vi.fn(async () => ({ allowed: true, reason: "allow", explanation: "" })),
    assertAllowed: vi.fn(),
    holdOrAssert: vi.fn(),
  })),
}));

function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...((err.details as Record<string, unknown>) ?? {}) });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "test error" });
}

/**
 * Build a chainable drizzle select mock. The bulk route runs one query when
 * connectionId is present:
 *   db.select({connection, grant}).from(toolConnections).innerJoin(...).where(...).limit(1)
 * We feed the resolved row (or undefined for "not found") through the chain.
 */
function makeDbWithConnectionRow(row: unknown): Db {
  const limitResult = Promise.resolve(row === undefined ? [] : [row]);
  const whereResult = { limit: (_n: number) => limitResult };
  const innerJoinResult = { where: (_cond: unknown) => whereResult };
  const fromResult = { innerJoin: (_table: unknown, _cond: unknown) => innerJoinResult };
  return {
    select: (_fields: unknown) => ({ from: (_table: unknown) => fromResult }),
  } as unknown as Db;
}

const emptyDb = {} as Db;

function boardApp(db: Db = emptyDb) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "board", source: "local_implicit" };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function healthyConnectionRow() {
  return {
    connection: {
      id: CONNECTION_ID,
      companyId: COMPANY_ID,
      enabled: true,
      status: "active",
      healthStatus: "ok",
      config: { ai: { provider: "anthropic", method: "api_key" } },
    },
    grant: { id: GRANT_ID, status: "active", kind: "organization" },
  };
}

describe("POST /companies/:companyId/agents/bulk-update-model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unknown model via real validation and reports every agent in failed[]", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      if (id === AGENT_2) return makeAgent(AGENT_2);
      if (id === AGENT_3) return makeAgent(AGENT_3);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
        runtimeConfig: { ...current.runtimeConfig, ...(patch.runtimeConfig as Record<string, unknown> ?? {}) },
      };
    });

    // INVALID_MODEL is not in the claude_local static catalog, so the bulk
    // route's assertMyrmidonAgentConfigChange rejects it on the real
    // production path — no mocked svc.update throw is involved.
    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1, AGENT_2, AGENT_3],
        model: INVALID_MODEL,
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(0);
    expect(res.body.failed).toHaveLength(3);
    for (const entry of res.body.failed) {
      expect(entry.reason).toBeTruthy();
      expect(entry.reason).toContain("Unknown model");
    }
    // No mutation happened, so no activity log.
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("updates agents with a valid model and writes activity log per mutation", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      if (id === AGENT_2) return makeAgent(AGENT_2);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
        runtimeConfig: { ...current.runtimeConfig, ...(patch.runtimeConfig as Record<string, unknown> ?? {}) },
      };
    });

    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1, AGENT_2],
        model: VALID_MODEL,
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(2);
    expect(res.body.updated).toContain(AGENT_1);
    expect(res.body.updated).toContain(AGENT_2);
    expect(res.body.failed).toHaveLength(0);

    // Activity log written for each successful mutation.
    expect(logActivityMock).toHaveBeenCalledTimes(2);
    expect(logActivityMock).toHaveBeenCalledWith(
      emptyDb,
      expect.objectContaining({
        action: "agent.updated",
        entityId: AGENT_1,
      }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      emptyDb,
      expect.objectContaining({
        action: "agent.updated",
        entityId: AGENT_2,
      }),
    );
  });

  it("rejects unknown agent ids in failed[] without touching others", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
      };
    });

    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1, AGENT_2],
        model: VALID_MODEL,
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([AGENT_1]);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(AGENT_2);
    expect(res.body.failed[0].reason).toBe("Agent not found");
  });

  it("binds a company-shared AI connection and writes the full binding object", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
        runtimeConfig: { ...current.runtimeConfig, ...(patch.runtimeConfig as Record<string, unknown> ?? {}) },
      };
    });

    const db = makeDbWithConnectionRow(healthyConnectionRow());
    const res = await request(boardApp(db))
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1],
        connectionId: CONNECTION_ID,
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([AGENT_1]);
    expect(res.body.failed).toHaveLength(0);

    // svc.update received the full AiConnectionBinding, not a bare UUID.
    const updatePatch = agentSvcMock.update.mock.calls[0][1] as Record<string, unknown>;
    expect(updatePatch.runtimeConfig).toEqual({
      aiConnection: {
        mode: "shared",
        connectionId: CONNECTION_ID,
        grantId: GRANT_ID,
        provider: "anthropic",
        method: "api_key",
      },
    });
  });

  it("returns 422 when connectionId does not resolve to a company connection", async () => {
    const db = makeDbWithConnectionRow(undefined);
    const res = await request(boardApp(db))
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1],
        connectionId: CONNECTION_ID,
      });

    expect(res.status).toBe(422);
    expect(agentSvcMock.getById).not.toHaveBeenCalled();
  });

  it("is idempotent: repeated call with same body succeeds", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1, { adapterConfig: { model: VALID_MODEL } });
      if (id === AGENT_2) return makeAgent(AGENT_2, { adapterConfig: { model: VALID_MODEL } });
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
        runtimeConfig: { ...current.runtimeConfig, ...(patch.runtimeConfig as Record<string, unknown> ?? {}) },
      };
    });

    const body = {
      agentIds: [AGENT_1, AGENT_2],
      model: VALID_MODEL,
    };

    const first = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.updated).toHaveLength(2);
    expect(first.body.failed).toHaveLength(0);

    const second = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.updated).toHaveLength(2);
    expect(second.body.failed).toHaveLength(0);
  });

  it("counts the agent as updated even when activity-log write fails", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      const current = await agentSvcMock.getById(id);
      return {
        ...current,
        adapterConfig: { ...current.adapterConfig, ...(patch.adapterConfig as Record<string, unknown> ?? {}) },
      };
    });
    // Activity-log persistence failure must not roll back the mutation nor
    // report the agent as failed: the agent update is already committed.
    logActivityMock.mockRejectedValueOnce(new Error("activity log unavailable"));

    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({
        agentIds: [AGENT_1],
        model: VALID_MODEL,
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual([AGENT_1]);
    expect(res.body.failed).toHaveLength(0);
    // The mutation still happened — svc.update was called.
    expect(agentSvcMock.update).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when neither model nor connectionId is provided", async () => {
    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({ agentIds: [AGENT_1] });

    expect(res.status).toBe(400);
  });

  it("returns 400 when agentIds is empty", async () => {
    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({ agentIds: [], model: VALID_MODEL });

    expect(res.status).toBe(400);
  });
});
