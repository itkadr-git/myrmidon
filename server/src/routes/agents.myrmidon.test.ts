// agents.myrmidon.test.ts
// 
// Tests for myrmidon autonomy matrix enforcement on agent instructions change routes

import { describe, it, beforeEach, afterEach, vi, expect } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { AUTONOMY_VERDICTS, type AutonomyActionClass, type AutonomyVerdict } from "@paperclipai/shared";
import { agentRoutes } from "./agents.js";
import { dbAutonomyGate, type AutonomyGate } from "../myrmidon/autonomy/gate.js";

// Mock database
const mockDb = {} as Db;

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

// Mock autonomy gate
vi.mock("../myrmidon/autonomy/gate.js", () => ({
  dbAutonomyGate: vi.fn((db: Db) => ({
    assertAllowed: vi.fn(async (req: Request, actionClass: AutonomyActionClass) => {
      // Mock implementation - allow all by default
      return { verdict: "allowed", role: "test_role", actionClass };
    }),
    decide: vi.fn(),
  })),
  AUTONOMY_FORBIDDEN_CODE: "autonomy_forbidden",
}));

describe("Myrmidon Autonomy Matrix - Instructions Change Routes", () => {
  let app: express.Application;
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    
    // Mock authentication middleware
    app.use((req: Request, res: Response, next: NextFunction) => {
      req.actor = { type: "agent", agentId: "test-agent-id" };
      next();
    });
    
    app.use("/api", agentRoutes(mockDb));
    vi.clearAllMocks();
  });

  describe("PATCH /agents/:id/instructions-path", () => {
    it("should call autonomy gate with change_instructions action class", async () => {
      const mockAssertAllowed = vi.fn().mockResolvedValue({ verdict: "allowed", role: "test_role", actionClass: "change_instructions" });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      await request(app)
        .patch("/api/agents/test-agent-id/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" })
        .expect(200);
        
      expect(mockAssertAllowed).toHaveBeenCalledWith(
        expect.anything(), 
        "change_instructions"
      );
    });

    it("should return 403 when autonomy verdict is forbidden", async () => {
      const mockAssertAllowed = vi.fn().mockImplementation(async () => {
        const { forbidden } = await import("../errors.js");
        throw forbidden("This action is forbidden for this role by the autonomy matrix", {
          code: "autonomy_forbidden",
          actionClass: "change_instructions",
          role: "test_role",
        });
      });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      await request(app)
        .patch("/api/agents/test-agent-id/instructions-path")
        .send({ path: "/path/to/instructions", adapterConfigKey: "instructionsFilePath" })
        .expect(403);
    });
  });

  describe("PATCH /agents/:id/instructions-bundle", () => {
    it("should call autonomy gate with change_instructions action class", async () => {
      const mockAssertAllowed = vi.fn().mockResolvedValue({ verdict: "allowed", role: "test_role", actionClass: "change_instructions" });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      const instructionsServiceMock = await import("../services/index.js");
      (instructionsServiceMock.agentInstructionsService().updateBundle as vi.Mock).mockResolvedValue({
        bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" },
        adapterConfig: {}
      });
      
      await request(app)
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" })
        .expect(200);
        
      expect(mockAssertAllowed).toHaveBeenCalledWith(
        expect.anything(), 
        "change_instructions"
      );
    });

    it("should return 403 when autonomy verdict is forbidden", async () => {
      const mockAssertAllowed = vi.fn().mockImplementation(async () => {
        const { forbidden } = await import("../errors.js");
        throw forbidden("This action is forbidden for this role by the autonomy matrix", {
          code: "autonomy_forbidden",
          actionClass: "change_instructions",
          role: "test_role",
        });
      });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      await request(app)
        .patch("/api/agents/test-agent-id/instructions-bundle")
        .send({ mode: "managed", rootPath: ".", entryFile: "AGENTS.md" })
        .expect(403);
    });
  });

  describe("DELETE /agents/:id/instructions-bundle/file", () => {
    it("should call autonomy gate with change_instructions action class", async () => {
      const mockAssertAllowed = vi.fn().mockResolvedValue({ verdict: "allowed", role: "test_role", actionClass: "change_instructions" });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      const instructionsServiceMock = await import("../services/index.js");
      (instructionsServiceMock.agentInstructionsService().deleteFile as vi.Mock).mockResolvedValue({
        bundle: { mode: "managed", rootPath: ".", entryFile: "AGENTS.md" }
      });
      
      await request(app)
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt")
        .expect(200);
        
      expect(mockAssertAllowed).toHaveBeenCalledWith(
        expect.anything(), 
        "change_instructions"
      );
    });

    it("should return 403 when autonomy verdict is forbidden", async () => {
      const mockAssertAllowed = vi.fn().mockImplementation(async () => {
        const { forbidden } = await import("../errors.js");
        throw forbidden("This action is forbidden for this role by the autonomy matrix", {
          code: "autonomy_forbidden",
          actionClass: "change_instructions",
          role: "test_role",
        });
      });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      await request(app)
        .delete("/api/agents/test-agent-id/instructions-bundle/file?path=test.txt")
        .expect(403);
    });
  });

  describe("POST /agents/:id/instructions-revisions/:revisionId/rollback", () => {
    it("should call autonomy gate with change_instructions action class", async () => {
      const mockAssertAllowed = vi.fn().mockResolvedValue({ verdict: "allowed", role: "test_role", actionClass: "change_instructions" });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const { agentInstructionsRevisionsRoutes } = await import("../myrmidon/agent-instructions-revisions/index.js");
      app.use("/api", agentInstructionsRevisionsRoutes(mockDb));
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
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
      (instructionsServiceMock.agentInstructionsService().materializeManagedBundle as vi.Mock).mockResolvedValue({
        adapterConfig: {},
      });
      
      await request(app)
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback")
        .expect(200);
        
      expect(mockAssertAllowed).toHaveBeenCalledWith(
        expect.anything(), 
        "change_instructions"
      );
    });

    it("should return 403 when autonomy verdict is forbidden", async () => {
      const mockAssertAllowed = vi.fn().mockImplementation(async () => {
        const { forbidden } = await import("../errors.js");
        throw forbidden("This action is forbidden for this role by the autonomy matrix", {
          code: "autonomy_forbidden",
          actionClass: "change_instructions",
          role: "test_role",
        });
      });
      (dbAutonomyGate as unknown as vi.Mock).mockReturnValue({
        assertAllowed: mockAssertAllowed,
        decide: vi.fn(),
      });
      
      const { agentInstructionsRevisionsRoutes } = await import("../myrmidon/agent-instructions-revisions/index.js");
      app.use("/api", agentInstructionsRevisionsRoutes(mockDb));
      
      const agentServiceMock = await import("../services/index.js");
      (agentServiceMock.agentService(mockDb).getById as vi.Mock).mockResolvedValue({
        id: "test-agent-id",
        companyId: "test-company-id",
        name: "Test Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
      });
      
      await request(app)
        .post("/api/agents/test-agent-id/instructions-revisions/test-revision-id/rollback")
        .expect(403);
    });
  });
});