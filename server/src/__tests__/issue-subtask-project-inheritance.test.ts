import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockWakeup = vi.fn(async () => ({ queued: false }));
const mockLogActivity = vi.fn(async () => undefined);

const parentIssue = {
  id: "parent-issue-1",
  companyId: "company-1",
  projectId: "proj-parent-123",
  title: "Parent Issue",
  status: "in_progress",
  casteKey: "engineer",
};

let capturedCreateInput: Record<string, unknown> | null = null;

const mockIssueService = {
  getById: vi.fn(async (id: string) => {
    if (id === parentIssue.id) return parentIssue;
    return null;
  }),
  create: vi.fn(async (_companyId: string, input: Record<string, unknown>) => {
    capturedCreateInput = input;
    return {
      id: "child-issue-1",
      companyId: "company-1",
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      title: input.title,
      status: input.status ?? "todo",
      identifier: "TEST-2",
    };
  }),
  listByIds: vi.fn(async () => []),
  update: vi.fn(async () => ({})),
  touchRunActivity: vi.fn(async () => undefined),
};

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: () => ({
      getById: vi.fn(async () => null),
    }),
    agentService: () => ({
    getById: vi.fn(async () => ({
      id: "agent-1",
      companyId: "company-1",
      status: "active",
      role: "engineer",
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {},
    })),
    getExperimental: vi.fn(async () => ({})),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
};
});

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
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
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("myrmidon(1.6.6 OPE-9996): Subtask inherits parent's projectId", () => {
  beforeEach(() => {
    capturedCreateInput = null;
    vi.clearAllMocks();
  });

  it("inherits parent's projectId when subtask is created without projectId", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Child task without projectId",
        parentId: parentIssue.id,
      });

    expect(res.status).toBe(201);
    expect(capturedCreateInput).not.toBeNull();
    expect(capturedCreateInput?.parentId).toBe(parentIssue.id);
    expect(capturedCreateInput?.projectId).toBe(parentIssue.projectId);
  });

  it("retains explicit projectId when provided on subtask create", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Child task with explicit projectId",
        parentId: parentIssue.id,
        projectId: "proj-different-456",
      });

    expect(res.status).toBe(201);
    expect(capturedCreateInput).not.toBeNull();
    expect(capturedCreateInput?.parentId).toBe(parentIssue.id);
    expect(capturedCreateInput?.projectId).toBe("proj-different-456");
  });

  it("does not set projectId when creating root task without projectId", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Root task without projectId",
      });

    expect(res.status).toBe(201);
    expect(capturedCreateInput).not.toBeNull();
    expect(capturedCreateInput?.parentId).toBeNull();
    expect(capturedCreateInput?.projectId).toBeNull();
  });
});
