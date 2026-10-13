// agents-autonomy-e2e.myrmidon.test.ts
//
// myrmidon(1.6-AUTONOMY): the route-level end-to-end case for the matrix.
//
// The sibling test next to this file (`agents.myrmidon.test.ts`) stubs the gate
// verdict and checks that each instructions route maps a verdict to a status
// code. This file closes the loop the other way round: it drives the REAL express
// route, the REAL gate and the REAL matrix document — only the DB-backed factory
// (`dbAutonomyGate`) is replaced by an in-memory store — and an agent caller who
// asks for a change the matrix forbids.
//
// What it proves, end to end:
//   matrix document (engineer × change_instructions = forbidden)
//     -> resolveAutonomy -> gate.decide -> route -> 403 autonomy_forbidden
//     -> the instructions bundle was NOT rewritten (state unchanged).
//
// The caller's instructions are irrelevant to the answer: an agent cannot talk
// its way into an action the matrix forbids.

import { describe, it, beforeEach, vi, expect } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { agentRoutes } from "./agents.js";

// Mock database handle: the route only passes it back to the gate factory and to
// the service factories, both of which are mocked below.
const mockDb = {} as Db;

const engineerAgentId = "11111111-2222-4333-8444-555555555555";

const testAgent = {
  id: engineerAgentId,
  companyId: "test-company-id",
  name: "Test Agent",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
};

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
  approvalService: vi.fn(() => ({ create: vi.fn(), listForIssue: vi.fn(), decide: vi.fn() })),
  builtInAgentService: vi.fn(() => ({ list: vi.fn(), get: vi.fn() })),
  companySkillService: vi.fn(() => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillEntries: vi.fn(),
  })),
  budgetService: vi.fn(() => ({ listForCompany: vi.fn(), getForAgent: vi.fn(), setForAgent: vi.fn() })),
  heartbeatService: vi.fn(() => ({})),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: vi.fn(() => ({})),
  issueRecoveryActionService: vi.fn(() => ({})),
  issueService: vi.fn(() => ({ addComment: vi.fn(), update: vi.fn() })),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn(async (x: unknown) => x),
  workspaceOperationService: vi.fn(() => ({})),
}));

vi.mock("../myrmidon/agent-instructions-revisions/service.js", () => ({
  recordAgentInstructionsRevision: vi.fn(),
  listAgentInstructionsRevisions: vi.fn(() => []),
  getAgentInstructionsRevision: vi.fn(),
  toRecord: vi.fn((x: unknown) => x),
}));

// The one seam this file replaces: the production gate factory reads the matrix
// from instance_settings and the role from the agents table. Here the gate is
// the real one and its matrix is the real document shape, stored in memory:
//
//   engineer × change_instructions = forbidden
//   engineer × delete             = forbidden  (the class the issues routes use)
//
// Everything downstream of the store (resolveAutonomy, decide, the 403 mapping)
// is the code under test.
vi.mock("../myrmidon/autonomy/gate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../myrmidon/autonomy/gate.js")>();
  const { emptyAutonomyDocument, memoryAutonomyStore } = await import("../myrmidon/autonomy/store.js");
  const document = emptyAutonomyDocument();
  document.matrix = {
    version: 1,
    rules: [
      { role: "engineer", actionClass: "change_instructions", verdict: "forbidden", agentId: null },
      { role: "engineer", actionClass: "delete", verdict: "forbidden", agentId: null },
    ],
    defaults: { ...document.matrix.defaults },
  };
  const store = memoryAutonomyStore(document);
  return {
    ...actual,
    dbAutonomyGate: () => actual.autonomyGate({ store, roleOf: async () => "engineer" }),
  };
});

/** Express error handler that turns HttpError into its JSON status response. */
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...((err.details as Record<string, unknown>) ?? {}) });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "test error" });
}

/** Agent actor with instructions that demand the forbidden change. */
function agentApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "agent", agentId: engineerAgentId, companyId: "test-company-id" };
    next();
  });
  app.use("/api", agentRoutes(mockDb));
  app.use(errorHandler);
  return app;
}

/** Board actor: the matrix constrains agents, not the board that edits it. */
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

describe("autonomy matrix, route-level end to end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentSvcMock.getById.mockResolvedValue(testAgent);
    instructionsSvcMock.updateBundle.mockResolvedValue({
      bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
      adapterConfig: {},
    });
  });

  it("refuses an agent instructions change with 403 autonomy_forbidden and writes nothing", async () => {
    const res = await request(agentApp())
      .patch(`/api/agents/${engineerAgentId}/instructions-bundle`)
      .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "autonomy_forbidden",
      actionClass: "change_instructions",
      role: "engineer",
    });
    // State unchanged: the seam refused before the bundle was rewritten.
    expect(instructionsSvcMock.updateBundle).not.toHaveBeenCalled();
  });

  it("lets the board take the same action, because the matrix binds agents only", async () => {
    const res = await request(boardApp())
      .patch(`/api/agents/${engineerAgentId}/instructions-bundle`)
      .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

    expect(res.status).not.toBe(403);
    // The board is not subject to the matrix, so the route runs its work.
    expect(instructionsSvcMock.updateBundle).toHaveBeenCalled();
  });

  it("refuses the same agent's delete of an agent instructions file", async () => {
    instructionsSvcMock.deleteFile.mockResolvedValue({
      bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
    });

    const res = await request(agentApp()).delete(
      `/api/agents/${engineerAgentId}/instructions-bundle/file?path=AGENTS.md`,
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
    expect(instructionsSvcMock.deleteFile).not.toHaveBeenCalled();
  });
});