// server/src/myrmidon/guard-return/guard-return.test.ts
// 1.6.6 GUARD-RETURN (OPE-9962): Comprehensive tests for sweep, guard, alert, and domain.

import { describe, expect, it, vi } from "vitest";
import {
  isNoncodingRole,
  isDevProjectCodeIssue,
  findEngineerPr,
  hasChangesRequestedVerdict,
  extractReviewRemarks,
  buildGuardReturnComment,
  buildGuardReturnWakePayload,
  decideGuardReturn,
  GUARD_RETURN_ACTIVITY_ACTION,
  type AgentSummary,
  type CommentSummary,
  type GuardReturnCandidate,
  type PrWorkProductSummary,
} from "./domain.js";
import { createGuardReturnSweep } from "./sweep.js";
import { evaluateCodeTasksOnNoncodingRolesAlert } from "./alert.js";

describe("1.6.6 GUARD-RETURN: domain logic", () => {
  const engineerAgent: AgentSummary = {
    id: "agent-eng-1",
    name: "eng-1",
    role: "engineer",
  };

  const reviewerAgent: AgentSummary = {
    id: "agent-rev-1",
    name: "rev-1",
    role: "reviewer",
  };

  const leadAgent: AgentSummary = {
    id: "agent-lead-1",
    name: "lead-1",
    role: "lead",
  };

  it("identifies non-coding roles correctly", () => {
    expect(isNoncodingRole("reviewer")).toBe(true);
    expect(isNoncodingRole("lead")).toBe(true);
    expect(isNoncodingRole("operator")).toBe(true);
    expect(isNoncodingRole("pm")).toBe(true);
    expect(isNoncodingRole("qa")).toBe(true);
    expect(isNoncodingRole("adm")).toBe(true);
    expect(isNoncodingRole("engineer")).toBe(false);
  });

  it("identifies dev-project code issues", () => {
    // 1. Project default caste is engineer
    expect(
      isDevProjectCodeIssue({
        labels: [],
        projectDefaultCasteKey: "engineer",
      }),
    ).toBe(true);

    // 2. Issue casteKey is engineer
    expect(
      isDevProjectCodeIssue({
        labels: [],
        casteKey: "engineer",
      }),
    ).toBe(true);

    // 3. Issue has needs-engineer label
    expect(
      isDevProjectCodeIssue({
        labels: ["needs-engineer"],
      }),
    ).toBe(true);

    // 4. Issue has pull_request work product
    expect(
      isDevProjectCodeIssue({
        labels: [],
        prWorkProducts: [{ id: "pr-1", type: "pull_request", status: "open" }],
      }),
    ).toBe(true);

    // 5. Ordinary non-code issue
    expect(
      isDevProjectCodeIssue({
        labels: ["documentation"],
        casteKey: "general",
        projectDefaultCasteKey: "general",
      }),
    ).toBe(false);
  });

  it("detects PR from an engineer", () => {
    const agentMap = new Map<string, AgentSummary>([
      [engineerAgent.id, engineerAgent],
      [reviewerAgent.id, reviewerAgent],
    ]);

    const runAgentMap = new Map<string, string>([["run-123", engineerAgent.id]]);

    const prs: PrWorkProductSummary[] = [
      {
        id: "pr-1",
        type: "pull_request",
        status: "open",
        createdByRunId: "run-123",
      },
    ];

    const result = findEngineerPr(prs, agentMap, runAgentMap);
    expect(result.hasPr).toBe(true);
    expect(result.authorAgentId).toBe(engineerAgent.id);

    // Rejects PR if creator is not an engineer
    const nonEngPrs: PrWorkProductSummary[] = [
      {
        id: "pr-2",
        type: "pull_request",
        status: "open",
        creatorAgentId: reviewerAgent.id,
      },
    ];
    const nonEngResult = findEngineerPr(nonEngPrs, agentMap);
    expect(nonEngResult.hasPr).toBe(false);
    expect(nonEngResult.authorAgentId).toBeNull();
  });

  it("detects changes_requested verdict from executionState and comments", () => {
    expect(
      hasChangesRequestedVerdict(
        { status: "changes_requested" },
      ),
    ).toBe(true);

    expect(
      hasChangesRequestedVerdict(
        { lastDecisionOutcome: "changes_requested" },
      ),
    ).toBe(true);

    expect(hasChangesRequestedVerdict(null)).toBe(false);

    // Comments are explanatory text, not execution verdicts.
    expect(hasChangesRequestedVerdict(null)).toBe(false);
  });

  it("extracts reviewer remarks and formats return comment", () => {
    const comments: CommentSummary[] = [
      {
        id: "c-1",
        body: "Please fix the failing vitest test on line 42",
        authorAgentId: reviewerAgent.id,
        createdAt: new Date(),
      },
    ];

    const remarks = extractReviewRemarks(comments, null, reviewerAgent.id);
    expect(remarks).toBe("Please fix the failing vitest test on line 42");

    const comment = buildGuardReturnComment("eng-1", remarks);
    expect(comment).toContain("Задача возвращена автору (@eng-1) в статус in_progress");
    expect(comment).toContain("Please fix the failing vitest test on line 42");
  });

  it("decides to return candidate when code task is held by non-coding role with changes_requested", () => {
    const agentMap = new Map<string, AgentSummary>([
      [engineerAgent.id, engineerAgent],
      [reviewerAgent.id, reviewerAgent],
    ]);

    const candidate: GuardReturnCandidate = {
      issueId: "issue-1",
      identifier: "OPE-1234",
      title: "Fix auth bug",
      companyId: "comp-1",
      status: "in_progress",
      assigneeAgentId: reviewerAgent.id,
      assigneeRole: reviewerAgent.role,
      projectId: "proj-1",
      casteKey: "engineer",
      labels: [],
      executionState: {
        status: "changes_requested",
        returnAssignee: { type: "agent", agentId: engineerAgent.id },
      },
      prWorkProducts: [],
      comments: [
        {
          id: "c-1",
          body: "CHANGES REQUESTED: handle 401 response",
          authorAgentId: reviewerAgent.id,
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const decision = decideGuardReturn(candidate, agentMap);
    expect(decision.action).toBe("return");
    expect(decision.targetAssigneeAgentId).toBe(engineerAgent.id);
    expect(decision.targetKind).toBe("return_assignee");
    expect(decision.remarksText).toContain("handle 401 response");
    expect(decision.commentBody).toContain("Задача возвращена автору");
  });

  it("skips pending review assigned to its participant even with an engineer PR", () => {
    const agentMap = new Map<string, AgentSummary>([
      [engineerAgent.id, engineerAgent],
      [reviewerAgent.id, reviewerAgent],
    ]);
    const candidate: GuardReturnCandidate = {
      issueId: "issue-review",
      identifier: "OPE-10324",
      title: "Review a change",
      companyId: "comp-1",
      status: "in_review",
      assigneeAgentId: reviewerAgent.id,
      assigneeRole: reviewerAgent.role,
      projectId: "proj-1",
      casteKey: "engineer",
      labels: [],
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgent.id },
      },
      prWorkProducts: [{ id: "pr-review", type: "pull_request", status: "open", creatorAgentId: engineerAgent.id }],
      comments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(decideGuardReturn(candidate, agentMap).action).toBe("skip");
  });

  it("does not treat engineer comments mentioning remarks as a verdict", () => {
    expect(hasChangesRequestedVerdict(null)).toBe(false);
  });
  it("skips return when task is already assigned to an engineer", () => {
    const agentMap = new Map<string, AgentSummary>([
      [engineerAgent.id, engineerAgent],
    ]);

    const candidate: GuardReturnCandidate = {
      issueId: "issue-2",
      identifier: "OPE-1235",
      title: "Add feature",
      companyId: "comp-1",
      status: "in_progress",
      assigneeAgentId: engineerAgent.id,
      assigneeRole: engineerAgent.role,
      projectId: "proj-1",
      casteKey: "engineer",
      labels: [],
      prWorkProducts: [],
      comments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const decision = decideGuardReturn(candidate, agentMap);
    expect(decision.action).toBe("skip");
  });
});

describe("1.6.6 GUARD-RETURN: sweeper execution", () => {
  it("returns stranded task, posts comment, wakes author, and logs activity", async () => {
    const now = new Date();
    const candidateIssue = {
      issueId: "issue-100",
      identifier: "OPE-9900",
      title: "Refactor database queries",
      companyId: "company-test",
      status: "in_review",
      assigneeAgentId: "agent-reviewer",
      projectId: "proj-100",
      casteKey: "engineer",
      labels: [],
      executionState: {
        status: "changes_requested",
        decisionReason: "Add index on user_id",
      },
      harnessKind: null,
      executionWorkspacePreference: null,
      createdAt: now,
      updatedAt: now,
      assigneeRole: "reviewer",
      assigneeName: "Reviewer 8",
      projectDefaultCasteKey: "engineer",
    };

    const engineerAgent = {
      id: "agent-engineer",
      name: "eng-20",
      role: "engineer",
      companyId: "company-test",
      status: "idle",
    };

    const prProduct = {
      id: "pr-100",
      issueId: "issue-100",
      type: "pull_request",
      status: "open",
      externalId: "123",
      createdByRunId: "run-eng-100",
      metadata: {},
    };

    const mockHeartbeatRun = {
      id: "run-eng-100",
      agentId: "agent-engineer",
    };

    const mockComments = [
      {
        id: "comm-1",
        issueId: "issue-100",
        body: "REQUEST CHANGES: Add index on user_id",
        authorAgentId: "agent-reviewer",
        authorType: "agent",
        createdAt: now,
      },
    ];

    const updatedIssues: any[] = [];
    const insertedComments: any[] = [];
    const insertedActivityLogs: any[] = [];
    const wakeupCalls: any[] = [];

    // Mock DB queries
    const mockDb: any = {
      select: vi.fn().mockImplementation((fields) => ({
        from: vi.fn().mockImplementation((table) => {
          return {
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([candidateIssue]),
              }),
              where: vi.fn().mockResolvedValue([]),
            }),
            where: vi.fn().mockImplementation(() => {
              // Handle queries based on table structure
              return {
                orderBy: vi.fn().mockResolvedValue(mockComments),
                then: (resolve: any) => {
                  if (table?._?.name === "heartbeat_runs" || fields?.agentId) {
                    return resolve([mockHeartbeatRun]);
                  }
                  if (table?._?.name === "issue_work_products" || fields?.externalId) {
                    return resolve([prProduct]);
                  }
                  if (fields?.companyId && fields?.role) {
                    return resolve([engineerAgent]);
                  }
                  if (fields?.name && fields?.role) {
                    return resolve([
                      { id: "agent-reviewer", name: "Reviewer 8", role: "reviewer" },
                      engineerAgent,
                    ]);
                  }
                  return resolve([engineerAgent]);
                },
              };
            }),
          };
        }),
      })),
      update: vi.fn().mockImplementation(() => ({
        set: vi.fn().mockImplementation((data) => ({
          where: vi.fn().mockImplementation((cond) => {
            updatedIssues.push(data);
            return Promise.resolve();
          }),
        })),
      })),
      insert: vi.fn().mockImplementation((table) => ({
        values: vi.fn().mockImplementation((data) => {
          if (data.authorType === "system") {
            insertedComments.push(data);
          } else if (data.action === GUARD_RETURN_ACTIVITY_ACTION) {
            insertedActivityLogs.push(data);
          }
          return Promise.resolve();
        }),
      })),
    };

    const mockWakeup = vi.fn().mockImplementation((agentId, options) => {
      wakeupCalls.push({ agentId, options });
      return Promise.resolve();
    });

    const sweeper = createGuardReturnSweep({
      db: mockDb,
      wakeup: mockWakeup,
      intervalSec: 300,
    });

    const result = await sweeper.sweep(now, { force: true });
    expect(result.candidateCount).toBe(1);
    expect(result.returnedCount).toBe(1);
    expect(result.returnedIssueIds).toContain("issue-100");

    // Verified updates
    expect(updatedIssues.length).toBe(1);
    expect(updatedIssues[0].status).toBe("in_progress");
    expect(updatedIssues[0].assigneeAgentId).toBe("agent-engineer");

    // Verified comment
    expect(insertedComments.length).toBe(1);
    expect(insertedComments[0].body).toContain("Задача возвращена автору");

    // Verified wakeup
    expect(wakeupCalls.length).toBe(1);
    expect(wakeupCalls[0].agentId).toBe("agent-engineer");
    expect(wakeupCalls[0].options.reason).toBe("execution_changes_requested");

    // Verified activity log
    expect(insertedActivityLogs.length).toBe(1);
    expect(insertedActivityLogs[0].action).toBe(GUARD_RETURN_ACTIVITY_ACTION);
  });

  it("respects 5-minute throttling interval between sweeps", async () => {
    const mockDb: any = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };
    const mockWakeup = vi.fn().mockResolvedValue(undefined);

    const sweeper = createGuardReturnSweep({
      db: mockDb,
      wakeup: mockWakeup,
      intervalSec: 300, // 5 min
    });

    const t0 = new Date(1700000000000);
    const r1 = await sweeper.sweep(t0);
    expect(r1.skipped).toBe(false);

    // Call after 2 minutes -> skipped
    const t1 = new Date(t0.getTime() + 120_000);
    const r2 = await sweeper.sweep(t1);
    expect(r2.skipped).toBe(true);

    // Call after 5+ minutes -> executed
    const t2 = new Date(t0.getTime() + 301_000);
    const r3 = await sweeper.sweep(t2);
    expect(r3.skipped).toBe(false);
  });
});

describe("1.6.6 GUARD-RETURN: alert evaluation", () => {
  it("evaluates alert as firing when code task on non-coding role exceeds 30 minutes", async () => {
    const now = new Date();
    const staleDate = new Date(now.getTime() - 35 * 60_000); // 35 minutes ago

    const mockCandidate = {
      id: "issue-alert-1",
      identifier: "OPE-9901",
      title: "Stalled task on lead",
      companyId: "comp-1",
      status: "in_progress",
      casteKey: "engineer",
      labels: [],
      harnessKind: null,
      executionWorkspacePreference: null,
      updatedAt: staleDate,
      createdAt: staleDate,
      assigneeRole: "lead",
      defaultCasteKey: "engineer",
    };

    const mockDb: any = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([mockCandidate]),
            }),
            where: vi.fn().mockResolvedValue([]),
          }),
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };

    const alertResult = await evaluateCodeTasksOnNoncodingRolesAlert(mockDb, "comp-1", now, 30 * 60_000);
    expect(alertResult.count).toBe(1);
    expect(alertResult.firing).toBe(true);
    expect(alertResult.breachedTasks.length).toBe(1);
    expect(alertResult.breachedTasks[0].issueId).toBe("issue-alert-1");
  });

  it("evaluates alert as not firing when duration is under 30 minutes", async () => {
    const now = new Date();
    const recentDate = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago

    const mockCandidate = {
      id: "issue-alert-2",
      identifier: "OPE-9902",
      title: "Recently assigned task",
      companyId: "comp-1",
      status: "in_progress",
      casteKey: "engineer",
      labels: [],
      harnessKind: null,
      executionWorkspacePreference: null,
      updatedAt: recentDate,
      createdAt: recentDate,
      assigneeRole: "reviewer",
      defaultCasteKey: "engineer",
    };

    const mockDb: any = {
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockImplementation(() => ({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([mockCandidate]),
            }),
            where: vi.fn().mockResolvedValue([]),
          }),
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };

    const alertResult = await evaluateCodeTasksOnNoncodingRolesAlert(mockDb, "comp-1", now, 30 * 60_000);
    expect(alertResult.count).toBe(1);
    expect(alertResult.firing).toBe(false);
    expect(alertResult.breachedTasks.length).toBe(0);
  });

  it("calculates duration from activity_log assignment timestamp rather than issue updatedAt", async () => {
    const now = new Date();
    // Issue updatedAt was bumped 5 minutes ago by unrelated edit
    const recentUpdatedAt = new Date(now.getTime() - 5 * 60_000);
    // But assignment to noncoding role happened 40 minutes ago in activityLog
    const assigned40MinAgo = new Date(now.getTime() - 40 * 60_000);

    const mockCandidate = {
      id: "issue-alert-3",
      identifier: "OPE-9903",
      title: "Task with recent update but stale noncoding assignment",
      companyId: "comp-1",
      status: "in_progress",
      casteKey: "engineer",
      labels: [],
      harnessKind: null,
      executionWorkspacePreference: null,
      since: assigned40MinAgo,
      updatedAt: recentUpdatedAt,
      createdAt: assigned40MinAgo,
      assigneeRole: "lead",
      defaultCasteKey: "engineer",
    };

    const mockActivityLog = [
      {
        issueId: "issue-alert-3",
        createdAt: assigned40MinAgo,
      },
    ];

    const mockDb: any = {
      select: vi.fn().mockImplementation((fields) => ({
        from: vi.fn().mockImplementation((table) => ({
          innerJoin: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([mockCandidate]),
            }),
            where: vi.fn().mockResolvedValue([]),
          }),
          where: vi.fn().mockResolvedValue(mockActivityLog),
        })),
      })),
    };

    const alertResult = await evaluateCodeTasksOnNoncodingRolesAlert(mockDb, "comp-1", now, 30 * 60_000);
    expect(alertResult.count).toBe(1);
    expect(alertResult.firing).toBe(true);
    expect(alertResult.breachedTasks.length).toBe(1);
    expect(alertResult.breachedTasks[0].durationMs).toBeGreaterThanOrEqual(40 * 60_000);
  });
});
