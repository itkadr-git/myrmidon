// agents.bulk-update-model.test.ts
//
// Tests for the 1.7 FLEET-OPS-BULK-API bulk model/connection update route
// (OPE-12224). Covers partial success (valid agents updated, invalid ones
// reported in failed[] with a reason), idempotency on repeated calls, and
// activity-log emission per mutation.

import { describe, it, beforeEach, vi, expect } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@myrmidon/db";
import { HttpError } from "../errors.js";
import { agentRoutes } from "./agents.js";

const mockDb = {} as Db;

const COMPANY_ID = "11111111-2222-4333-8444-555555555555";
const AGENT_1 = "22222222-2222-4333-8444-555555555555";
const AGENT_2 = "33333333-2222-4333-8444-555555555555";
const AGENT_3 = "44444444-2222-4333-8444-555555555555";

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId: COMPANY_ID,
    name: `Agent ${id}`,
    role: "engineer",
    adapterType: "claude_local",
    adapterConfig: { model: "claude-3-sonnet" },
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

function boardApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "board", source: "local_implicit" };
    next();
  });
  app.use("/api", agentRoutes(mockDb));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/agents/bulk-update-model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates valid agents and reports invalid model in failed[]", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1);
      if (id === AGENT_2) return makeAgent(AGENT_2);
      if (id === AGENT_3) return makeAgent(AGENT_3);
      return null;
    });
    agentSvcMock.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
      if (id === AGENT_3) {
        // Simulate a validation failure for the third agent (invalid model).
        throw Object.assign(new Error("Invalid model: not-a-real-model"), { status: 422 });
      }
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
        agentIds: [AGENT_1, AGENT_2, AGENT_3],
        model: "claude-3-opus",
      });

    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(2);
    expect(res.body.updated).toContain(AGENT_1);
    expect(res.body.updated).toContain(AGENT_2);
    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].id).toBe(AGENT_3);
    expect(res.body.failed[0].reason).toBeTruthy();

    // Activity log written for each successful mutation.
    expect(logActivityMock).toHaveBeenCalledTimes(2);
    expect(logActivityMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: "agent.updated",
        entityId: AGENT_1,
      }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: "agent.updated",
        entityId: AGENT_2,
      }),
    );
  });

  it("is idempotent: repeated call with same body succeeds", async () => {
    agentSvcMock.getById.mockImplementation(async (id: string) => {
      if (id === AGENT_1) return makeAgent(AGENT_1, { adapterConfig: { model: "claude-3-opus" } });
      if (id === AGENT_2) return makeAgent(AGENT_2, { adapterConfig: { model: "claude-3-opus" } });
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
      model: "claude-3-opus",
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

  it("returns 400 when neither model nor connectionId is provided", async () => {
    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({ agentIds: [AGENT_1] });

    expect(res.status).toBe(400);
  });

  it("returns 400 when agentIds is empty", async () => {
    const res = await request(boardApp())
      .post(`/api/companies/${COMPANY_ID}/agents/bulk-update-model`)
      .send({ agentIds: [], model: "claude-3-opus" });

    expect(res.status).toBe(400);
  });
});
