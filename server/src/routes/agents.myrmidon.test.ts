// agents.myrmidon.test.ts
//
// Tests for myrmidon autonomy matrix enforcement on agent instructions change routes.
// myrmidon(1.6.2-AUTONOMY-MATRIX): every instructions-change route must consult the
// autonomy gate for the change_instructions action class. forbidden -> 403
// autonomy_forbidden; approval_required -> 403 autonomy_approval_required (deny
// until the holding-action follow-up); board callers are not subject to the matrix.

import { describe, it, beforeEach, vi, expect } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { agentRoutes } from "./agents.js";
import { dbAutonomyGate } from "../myrmidon/autonomy/gate.js";

// Mock database
const mockDb = {} as Db;

const testAgent = {
  id: "test-agent-id",
  companyId: "test-company-id",
  name: "Test Agent",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
};

// Mock services
vi.mock("../services/index.js", () => ({
  agentService: vi.fn(() => ({
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
  })),
  agentInstructionsService: vi.fn(() => ({
    getBundle: vi.fn(),
    updateBundle: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    materializeManagedBundle: vi.fn(),
  })),
  accessService: vi.fn(() => ({
    decide: vi.fn(),
    hasPermission: vi.fn(),
    canUser: vi.fn(),
    listPrincipalGrants: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
    getMembership: vi.fn(),
  })),
  companySkillService: vi.fn(() => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillEntries: vi.fn(),
  })),
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

/** Fresh express app with an agent-type actor (the matrix only binds agents). */
function agentApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "agent", agentId: "test-agent-id" };
    next();
  });
  app.use("/api", agentRoutes(mockDb));
  return app;
}

/** Board actor: the matrix must not constrain the board at all. */
function boardApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = { type: "board" };
    next();
  });
  app.use("/api", agentRoutes(mockDb));
  return app;
}

async function primeAgentLookup() {
  const agentServiceMock = await import("../services/index.js");
  (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue(testAgent);
}

async function primeBundleUpdate() {
  const instructionsServiceMock = await import("../services/index.js");
  (instructionsServiceMock.agentInstructionsService().updateBundle as vi.Mock).mockResolvedValue({
    bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
    adapterConfig: {},
  });
}

async function primeDeleteFile() {
  const instructionsServiceMock = await import("../services/index.js");
  (instructionsServiceMock.agentInstructionsService().deleteFile as vi.Mock).mockResolvedValue({
    bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
  });
}

async function primeRollback(rollbacksApp: express.Application) {
  const { agentInstructionsRevisionsRoutes } = await import(
    "../myrmidon/agent-instructions-revisions/index.js"
  );
  rollbacksApp.use("/api", agentInstructionsRevisionsRoutes(mockDb));
  await primeAgentLookup();
  const revisionServiceMock = await import("../myrmidon/agent-instructions-revisions/service.js");
  (revisionServiceMock.getAgentInstructionsRevision as vi.Mock).mockResolvedValue({
    id: "test-revision-id",
    revisionNumber: 1,
    entryFile: "AGENTS.md",
    files: [{ path: "AGENTS.md", content: "# Test" }],
    source: "test",
    createdByAgentId: null,
    createdByUserId: "test-user",
    createdAt: new Date(),
  });
  const instructionsServiceMock = await import("../services/index.js");
  (instructionsServiceMock.agentInstructionsService().materializeManagedBundle as vi.Mock)
    .mockResolvedValue({ adapterConfig: {} });
}

describe("Myrmidon Autonomy Matrix - Instructions Change Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDecide.mockReset();
  });

  describe("PATCH /agents/:id/instructions-path", () => {
    it("consults the gate for change_instructions and allows when verdict is allowed", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .patch("/api/agents/test-agent-id/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .patch("/api/agents/test-agent-id/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "autonomy_forbidden",
        actionClass: "change_instructions",
        role: "engineer",
      });
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .patch("/api/agents/test-agent-id/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({
        code: "autonomy_approval_required",
        actionClass: "change_instructions",
        role: "engineer",
      });
    });

    it("passes a board caller through (gate returns allowed for non-agents)", async () => {
      // The gate's decide() itself returns allowed for a non-agent caller; the
      // route consults it once with the same action class and passes through.
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(boardApp())
        .patch("/api/agents/test-agent-id/instructions-path")
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
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden and does not update the bundle", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();
      const instructionsServiceMock = await import("../services/index.js");
      const updateBundle = instructionsServiceMock.agentInstructionsService().updateBundle as vi.Mock;
      updateBundle.mockClear();

      const res = await request(agentApp())
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
      // The bundle was not rewritten when the verdict denied the change.
      expect(updateBundle).not.toHaveBeenCalled();
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();
      const instructionsServiceMock = await import("../services/index.js");
      const updateBundle = instructionsServiceMock.agentInstructionsService().updateBundle as vi.Mock;
      updateBundle.mockClear();

      const res = await request(agentApp())
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
      expect(updateBundle).not.toHaveBeenCalled();
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeBundleUpdate();

      const res = await request(boardApp())
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" });

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
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt");

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      await primeAgentLookup();

      const res = await request(agentApp())
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      await primeAgentLookup();
      await primeDeleteFile();

      const res = await request(boardApp())
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt");

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
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback");

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });

    it("returns 403 autonomy_forbidden when the role's verdict is forbidden and materializes no revision", async () => {
      mockDecide.mockResolvedValue({ verdict: "forbidden", role: "engineer", actionClass: "change_instructions" });
      const app = agentApp();
      await primeRollback(app);
      const instructionsServiceMock = await import("../services/index.js");
      const materialize = instructionsServiceMock.agentInstructionsService().materializeManagedBundle as vi.Mock;
      materialize.mockClear().mockResolvedValue({ adapterConfig: {} });

      const res = await request(app)
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_forbidden" });
      // No revision materialization happened: the instructions were not rewritten.
      expect(materialize).not.toHaveBeenCalled();
    });

    it("returns 403 autonomy_approval_required when the verdict is approval_required and materializes no revision", async () => {
      mockDecide.mockResolvedValue({ verdict: "approval_required", role: "engineer", actionClass: "change_instructions" });
      const app = agentApp();
      await primeRollback(app);
      const instructionsServiceMock = await import("../services/index.js");
      const materialize = instructionsServiceMock.agentInstructionsService().materializeManagedBundle as vi.Mock;
      materialize.mockClear().mockResolvedValue({ adapterConfig: {} });

      const res = await request(app)
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "autonomy_approval_required" });
      expect(materialize).not.toHaveBeenCalled();
    });

    it("passes a board caller through", async () => {
      mockDecide.mockResolvedValue({ verdict: "allowed", role: null, actionClass: "change_instructions" });
      const app = boardApp();
      await primeRollback(app);

      const res = await request(app)
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback");

      expect(mockDecide).toHaveBeenCalledWith(expect.anything(), "change_instructions");
      expect(res.status).not.toBe(403);
    });
  });
});
