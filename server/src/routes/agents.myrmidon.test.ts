// agents.myrmidon.test.ts
//
// Tests for myrmidon autonomy matrix enforcement on agent instructions change routes.
// myrmidon(1.6.2-AUTONOMY-MATRIX): every instructions-change route must consult the
// autonomy gate for the change_instructions action class. forbidden -> 403
// autonomy_forbidden; approval_required -> 403 autonomy_approval_required (deny
// until the holding-action follow-up); board callers are not subject to the matrix.

import { describe, it, beforeEach, vi, expect, type Mock } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { agentRoutes } from "./agents.js";
import { dbAutonomyGate } from "../myrmidon/autonomy/gate.js";

// Mock database
const mockDb = {} as Db;

const testAgent = {
  id: "11111111-2222-4333-8444-555555555555",
  companyId: "test-company-id",
  name: "Test Agent",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
};

// Mock services: agentRoutes pulls many services from ../services/index.js at
// construction time, so the factory mock must cover the full import surface.
// Factories return SINGLETON objects so per-test mockResolvedValue survives
// the route calling the factory again.
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
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn(async (x: unknown) => x),
  workspaceOperationService: vi.fn(() => ({})),
}));

// Mock the revision service used by the rollback route.
vi.mock("../myrmidon/agent-instructions-revisions/service.js", () => ({
  recordAgentInstructionsRevision: vi.fn(),
  listAgentInstructionsRevisions: vi.fn(() => []),
  getAgentInstructionsRevision: vi.fn(),
  toRecord: vi.fn((x: unknown) => x),
}));

// Mock the autonomy gate: the routes call decide() and map the verdict to
// 403 codes themselves, so the mock only needs to return the verdict.
const mockDecide = vi.fn();
vi.mock("../myrmidon/autonomy/gate.js", () => ({
  dbAutonomyGate: vi.fn(() => ({
    decide: mockDecide,
    assertAllowed: vi.fn(),
  })),
}));

/** Express error handler that turns HttpError into its JSON status response. */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...((err.details as Record<string, unknown>) ?? {}) });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "test error" });
}

/** Fresh express app with an agent-type actor (the matrix only binds agents). */
function agentApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "agent", agentId: "11111111-2222-4333-8444-555555555555", companyId: "test-company-id" };
    next();
  });
  app.use("/api", agentRoutes(mockDb));
  app.use(errorHandler);
  return app;
}

/** Board actor: the matrix must not constrain the board at all. */
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

async function primeAgentLookup() {
  agentSvcMock.getById.mockResolvedValue(testAgent);
}

async function primeBundleUpdate() {
  instructionsSvcMock.updateBundle.mockResolvedValue({
    bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
    adapterConfig: {},
  });
}

async function primeDeleteFile() {
  instructionsSvcMock.deleteFile.mockResolvedValue({
    bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
  });
}

const revisionSvcMock = await import("../myrmidon/agent-instructions-revisions/service.js");

async function primeRollback(rollbacksApp: express.Application) {
  const { agentInstructionsRevisionsRoutes } = await import(
    "../myrmidon/agent-instructions-revisions/index.js"
  );
  rollbacksApp.use("/api", agentInstructionsRevisionsRoutes(mockDb));
  await primeAgentLookup();
  (revisionSvcMock.getAgentInstructionsRevision as unknown as Mock).mockResolvedValue({
    id: "test-revision-id",
    revisionNumber: 1,
    entryFile: "AGENTS.md",
    files: [{ path: "AGENTS.md", content: "# Test" }],
    source: "test",
    createdByAgentId: null,
    createdByUserId: "test-user",
    createdAt: new Date(),
  });
  instructionsSvcMock.materializeManagedBundle.mockResolvedValue({ adapterConfig: {} });
}

describe("Myrmidon Autonomy Matrix - Instructions Change Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecide.mockReset();
  });

  describe("PATCH /agents/:id/instructions-path", () => {
    // The vendored route rejects non-board callers before the gate ("Only
    // board-authenticated callers can manage instructions path or bundle
    // configuration"), so the autonomy seam on this route is defense in depth
    // for the day an agent-visible caller is added: the gate still runs for
    // callers that pass the vendor check.
    it("rejects an agent caller with the vendor 403 before the gate (agents never manage instructions-path)", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        error: "Only board-authenticated callers can manage instructions path or bundle configuration",
      });
    });

    it("consults the gate for change_instructions on a caller that passes the vendor check", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(boardApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(mockDecide).toHaveBeenCalledTimes(1);
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the gate's verdict is forbidden", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(boardApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "autonomy_forbidden",
        actionClass: "change_instructions",
      });
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(boardApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "autonomy_approval_required",
        actionClass: "change_instructions",
      });
    });

    it("passes a board caller through (gate returns allowed for non-agents)", async () => {
      // The gate's decide() itself returns allowed for a non-agent caller; the
      // route consults it once with the same action class and passes through.
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(boardApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(mockDecide).toHaveBeenCalledTimes(1);
      expect(res.status).not.toBe(403);
    });
  });

  describe("PATCH /agents/:id/instructions-bundle", () => {
    it("consults the gate for change_instructions and allows when verdict is allowed", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();

      const res = await request(agentApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden and does not update the bundle", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();
      instructionsSvcMock.updateBundle.mockClear();

      const res = await request(agentApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
      // The bundle was not rewritten when the verdict denied the change.
      expect(instructionsSvcMock.updateBundle).not.toHaveBeenCalled();
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();
      instructionsSvcMock.updateBundle.mockClear();

      const res = await request(agentApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
      expect(instructionsSvcMock.updateBundle).not.toHaveBeenCalled();
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();

      const res = await request(boardApp())
        .patch("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });
  });

  describe("DELETE /agents/:id/instructions-bundle/file", () => {
    it("consults the gate for change_instructions and allows when verdict is allowed", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeDeleteFile();

      const res = await request(agentApp())
        .delete("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle/file?path=test.txt");

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .delete("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle/file?path=test.txt");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .delete("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle/file?path=test.txt");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeDeleteFile();

      const res = await request(boardApp())
        .delete("/api/agents/11111111-2222-4333-8444-555555555555/instructions-bundle/file?path=test.txt");

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });
  });

  describe("POST /agents/:id/instructions-revisions/:revisionId/rollback", () => {
    it("consults the gate for change_instructions and allows when verdict is allowed", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: "engineer", actionClass: "change_instructions" });
      const app = agentApp();
      await primeRollback(app);

      const res = await request(app)
        .post("/api/agents/11111111-2222-4333-8444-555555555555/instructions-revisions/test-revision-id/rollback");

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden and materializes no revision", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      const app = agentApp();
      await primeRollback(app);
      const materialize = instructionsSvcMock.materializeManagedBundle;
      materialize.mockClear().mockResolvedValue({ adapterConfig: {} });

      const res = await request(app)
        .post("/api/agents/11111111-2222-4333-8444-555555555555/instructions-revisions/test-revision-id/rollback");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
      // No revision materialization happened: the instructions were not rewritten.
      expect(materialize).not.toHaveBeenCalled();
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required and materializes no revision", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      const app = agentApp();
      await primeRollback(app);
      const materialize = instructionsSvcMock.materializeManagedBundle;
      materialize.mockClear().mockResolvedValue({ adapterConfig: {} });

      const res = await request(app)
        .post("/api/agents/11111111-2222-4333-8444-555555555555/instructions-revisions/test-revision-id/rollback");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
      expect(materialize).not.toHaveBeenCalled();
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      const app = boardApp();
      await primeRollback(app);

      const res = await request(app)
        .post("/api/agents/11111111-2222-4333-8444-555555555555/instructions-revisions/test-revision-id/rollback");

      if (mockDecide.mock.calls.length === 0) console.log("DEBUG:", res.status, JSON.stringify(res.body).slice(0, 400));
      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });
  });
});
