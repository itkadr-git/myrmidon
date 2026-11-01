import { describe, expect, it, vi } from "vitest";
import {
  classifyEmptyRun,
  evaluateCompletionGate,
  checkAndHandleEmptyRunEscalation,
  getCompanyEmptyRunStats,
  recordEmptyRunEvent,
  DEVEFF_EVENT_NO_OP,
  DEVEFF_EVENT_REPEATED_TOOL_ERROR,
  DEVEFF_DASHBOARD_SQL_QUERY,
  MAX_CONSECUTIVE_EMPTY_RUNS,
  MAX_REPEATED_TOOL_ERRORS,
} from "../services/empty-run.js";
import * as heartbeatEvents from "../services/heartbeat-run-events.js";

describe("1.7 AGENT-RUNTIME: Stop conditions and empty runs (OPE-10096)", () => {
  describe("classifyEmptyRun", () => {
    it("classifies run as empty when there are no changes, artifacts, or status change", () => {
      const result = classifyEmptyRun({
        runId: "run-1",
        issueId: "issue-1",
        agentId: "agent-1",
        statusBefore: "in_progress",
        statusAfter: "in_progress",
        workProductsCreated: 0,
        commitsCreated: 0,
        pullRequestsCreated: 0,
        documentRevisionsCreated: 0,
        workspaceOperationsCreated: 0,
        hasFileOrArtifactChanges: false,
      });

      expect(result.isEmpty).toBe(true);
      expect(result.reason).toBe("no_changes_and_no_status_transition");
    });

    it("classifies run as empty when repeated tool errors exceed threshold", () => {
      const result = classifyEmptyRun({
        runId: "run-2",
        repeatedToolErrorCount: MAX_REPEATED_TOOL_ERRORS,
        repeatedToolErrorDetails: "patch failed 3 times",
      });

      expect(result.isEmpty).toBe(true);
      expect(result.reason).toBe("repeated_tool_errors");
      expect(result.description).toContain("patch failed 3 times");
    });

    it("does not classify run as empty when tool error count is below threshold even with details string", () => {
      const result = classifyEmptyRun({
        runId: "run-2-sub",
        repeatedToolErrorCount: 1,
        repeatedToolErrorDetails: "failed once",
        workProductsCreated: 1,
      });

      expect(result.isEmpty).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("classifies run as empty when livenessState is empty_response", () => {
      const result = classifyEmptyRun({
        runId: "run-3",
        livenessState: "empty_response",
      });

      expect(result.isEmpty).toBe(true);
      expect(result.reason).toBe("empty_response");
    });

    it("classifies run as productive when commits or work products are created", () => {
      const result = classifyEmptyRun({
        runId: "run-4",
        statusBefore: "in_progress",
        statusAfter: "in_progress",
        workProductsCreated: 1,
      });

      expect(result.isEmpty).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("classifies run as productive when issue status changes", () => {
      const result = classifyEmptyRun({
        runId: "run-5",
        statusBefore: "in_progress",
        statusAfter: "in_review",
      });

      expect(result.isEmpty).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("classifies run as non-empty when explicit blocker is set", () => {
      const result = classifyEmptyRun({
        runId: "run-6",
        statusBefore: "in_progress",
        statusAfter: "blocked",
        isExplicitBlocker: true,
        blockerReason: "Waiting for external API key",
      });

      expect(result.isEmpty).toBe(false);
      expect(result.reason).toBeNull();
    });

    it("does not treat run as explicit blocker if status is blocked without blockerReason", () => {
      const result = classifyEmptyRun({
        runId: "run-6-no-reason",
        statusBefore: "in_progress",
        statusAfter: "blocked",
        isExplicitBlocker: false,
        blockerReason: null,
      });

      expect(result.isEmpty).toBe(true);
      expect(result.reason).toBe("no_changes_and_no_status_transition");
    });
  });

  describe("evaluateCompletionGate", () => {
    it("passes gate when commit or PR or work product is created", () => {
      const gate = evaluateCompletionGate({
        runId: "run-10",
        commitsCreated: 1,
      });

      expect(gate.passed).toBe(true);
      expect(gate.gateMet).toBe("commit_or_pr");
    });

    it("passes gate when status changed", () => {
      const gate = evaluateCompletionGate({
        runId: "run-11",
        statusBefore: "in_progress",
        statusAfter: "in_review",
      });

      expect(gate.passed).toBe(true);
      expect(gate.gateMet).toBe("status_change");
    });

    it("passes gate when explicit blocker is declared", () => {
      const gate = evaluateCompletionGate({
        runId: "run-12",
        statusAfter: "blocked",
        blockerReason: "blocked by dependency",
      });

      expect(gate.passed).toBe(true);
      expect(gate.gateMet).toBe("explicit_blocker");
    });

    it("fails gate when status is blocked without blockerReason", () => {
      const gate = evaluateCompletionGate({
        runId: "run-12-no-reason",
        statusAfter: "blocked",
        blockerReason: null,
      });

      expect(gate.passed).toBe(false);
      expect(gate.gateMet).toBe("none");
    });

    it("fails gate when run ends in in_progress with no commits/PRs/artifacts or blockers", () => {
      const gate = evaluateCompletionGate({
        runId: "run-13",
        statusBefore: "in_progress",
        statusAfter: "in_progress",
        commitsCreated: 0,
        pullRequestsCreated: 0,
        workProductsCreated: 0,
      });

      expect(gate.passed).toBe(false);
      expect(gate.gateMet).toBe("none");
      expect(gate.reason).toContain("Completion gate failed");
    });
  });

  describe("checkAndHandleEmptyRunEscalation", () => {
    it("resets streak on productive run", async () => {
      const db = {} as any;
      const res = await checkAndHandleEmptyRunEscalation(db, {
        companyId: "comp-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-20",
        classification: { isEmpty: false, reason: null, description: "Productive" },
        gateResult: { passed: true, gateMet: "commit_or_pr", reason: "Commit created" },
      });

      expect(res.escalated).toBe(false);
      expect(res.consecutiveEmptyRuns).toBe(0);
      expect(res.shouldRewake).toBe(true);
    });

    it("allows rewake (shouldRewake: true) when consecutive empty runs are below threshold", async () => {
      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: "run-prev-1", livenessState: "empty_response" },
                ]),
              }),
            }),
          }),
        }),
      };

      const res = await checkAndHandleEmptyRunEscalation(mockDb, {
        companyId: "comp-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-2",
        classification: {
          isEmpty: true,
          reason: "empty_response",
          description: "Empty",
        },
        gateResult: {
          passed: false,
          gateMet: "none",
          reason: "Gate failed",
        },
      });

      expect(res.escalated).toBe(false);
      expect(res.consecutiveEmptyRuns).toBe(2);
      expect(res.shouldRewake).toBe(true);
    });

    it("escalates and blocks issue after 5 consecutive empty runs", async () => {
      const insertedComments: any[] = [];
      const updatedIssues: any[] = [];
      const insertedActivities: any[] = [];

      const mockDb: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: "run-prev-4", livenessState: "empty_response" },
                  { id: "run-prev-3", livenessState: "empty_response" },
                  { id: "run-prev-2", livenessState: "empty_response" },
                  { id: "run-prev-1", livenessState: "empty_response" },
                ]),
              }),
            }),
          }),
        }),
        insert: vi.fn().mockImplementation((table) => ({
          values: vi.fn().mockImplementation((val) => {
            if (val.body) insertedComments.push(val);
            if (val.action) insertedActivities.push(val);
            return Promise.resolve();
          }),
        })),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((val) => {
            updatedIssues.push(val);
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
      };

      const res = await checkAndHandleEmptyRunEscalation(mockDb, {
        companyId: "comp-1",
        issueId: "issue-1",
        agentId: "agent-1",
        runId: "run-5",
        classification: {
          isEmpty: true,
          reason: "no_changes_and_no_status_transition",
          description: "Run produced no file changes, commits, PRs, work products, or status transition",
        },
        gateResult: {
          passed: false,
          gateMet: "none",
          reason: "Completion gate failed",
        },
      });

      expect(res.escalated).toBe(true);
      expect(res.consecutiveEmptyRuns).toBe(5);
      expect(res.shouldRewake).toBe(false);
      expect(insertedComments.length).toBe(1);
      expect(insertedComments[0].body).toContain("[STOP CONDITION / IDLE_LOOP]");
      expect(updatedIssues.length).toBe(1);
      expect(updatedIssues[0].status).toBe("blocked");
      expect(updatedIssues[0].blockerMetadata?.blockReason).toBe("recovery");
      expect(updatedIssues[0].blockerMetadata?.owner?.agentId).toBe("agent-1");
    });
  });

  describe("getCompanyEmptyRunStats", () => {
    it("aggregates empty runs and calculates 14-day ratios", async () => {
      const mockDb: any = {
        select: vi.fn().mockImplementation((shape) => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              if (shape.role) {
                // agents query
                return Promise.resolve([
                  { id: "agent-1", name: "Dev 1", role: "developer" },
                  { id: "agent-2", name: "Dev 2", role: "developer" },
                ]);
              }
              // heartbeat_runs query
              return Promise.resolve([
                {
                  id: "r1",
                  agentId: "agent-1",
                  status: "succeeded",
                  livenessState: "empty_response",
                  livenessReason: "no concrete action evidence",
                },
                {
                  id: "r2",
                  agentId: "agent-1",
                  status: "succeeded",
                  livenessState: "progress",
                  livenessReason: "completed PR",
                },
                {
                  id: "r3",
                  agentId: "agent-2",
                  status: "succeeded",
                  livenessState: "progress",
                  livenessReason: "work product created",
                },
              ]);
            }),
          })),
        })),
      };

      const report = await getCompanyEmptyRunStats(mockDb, {
        companyId: "comp-1",
        days: 14,
      });

      expect(report.summary.totalRuns).toBe(3);
      expect(report.summary.emptyRuns).toBe(1);
      expect(report.summary.emptyRunRatio).toBeCloseTo(33.3, 1);
      expect(report.summary.targetReductionPercent).toBe(30);

      const agent1 = report.agents.find((a) => a.agentId === "agent-1");
      expect(agent1?.totalRuns).toBe(2);
      expect(agent1?.emptyRuns).toBe(1);
      expect(agent1?.emptyRunRatio).toBe(50);

      const agent2 = report.agents.find((a) => a.agentId === "agent-2");
      expect(agent2?.totalRuns).toBe(1);
      expect(agent2?.emptyRuns).toBe(0);
      expect(agent2?.emptyRunRatio).toBe(0);
      expect(report.dashboardSqlQuery).toBe(DEVEFF_DASHBOARD_SQL_QUERY);
      expect(report.dashboardSqlQuery).toContain("WITH runs_14d AS");
      expect(report.dashboardSqlQuery).toContain("run.deveff.no_op");
      expect(report.dashboardSqlQuery).toContain("run.deveff.repeated_tool_error");
    });
  });

  describe("1.7 DEVEFF: recordEmptyRunEvent (OPE-10096)", () => {
    it("emits run.deveff.no_op event with valid schema when run has no changes", async () => {
      const mockDb = {} as any;
      const spy = vi.spyOn(heartbeatEvents, "appendHeartbeatRunEvent");
      await recordEmptyRunEvent(mockDb, {
        companyId: "comp-1", runId: "run-123", agentId: "agent-1", issueId: "issue-1",
        classification: { isEmpty: true, reason: "no_changes_and_no_status_transition", description: "Run produced no file changes, work products, commits, PRs, or status transition" },
        gateResult: { passed: false, gateMet: "none", reason: "Completion gate failed: run ended without commit/PR, status change, or explicit blocker with reason" },
      });
      expect(spy).toHaveBeenCalledWith(mockDb, expect.objectContaining({ eventType: DEVEFF_EVENT_NO_OP, level: "info", payload: expect.objectContaining({ rule: "no_op", gatePassed: false }) }));
    });

    it("calculates 14-day baseline and verifies 30% reduction criterion", async () => {
      let callCount = 0;
      const mockDb: any = {
        select: vi.fn().mockImplementation((shape) => ({
          from: vi.fn().mockImplementation(() => ({
            where: vi.fn().mockImplementation(() => {
              if (shape.role) {
                // agents query
                return Promise.resolve([{ id: "agent-1", name: "Dev 1", role: "developer" }]);
              }
              callCount++;
              if (callCount === 1) {
                // current period: 10 runs, 2 empty (20%)
                return Promise.resolve([
                  { id: "cur-1", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                  { id: "cur-2", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                  ...Array(8).fill({ id: "cur-p", agentId: "agent-1", status: "succeeded", livenessState: "progress" }),
                ]);
              }
              // baseline period: 10 runs, 5 empty (50%)
              return Promise.resolve([
                { id: "base-1", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                { id: "base-2", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                { id: "base-3", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                { id: "base-4", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                { id: "base-5", agentId: "agent-1", status: "succeeded", livenessState: "empty_response" },
                ...Array(5).fill({ id: "base-p", agentId: "agent-1", status: "succeeded", livenessState: "progress" }),
              ]);
            }),
          })),
        })),
      };

      const report = await getCompanyEmptyRunStats(mockDb, {
        companyId: "comp-1",
        days: 14,
      });

      expect(report.summary.baselineTotalRuns).toBe(10);
      expect(report.summary.baselineEmptyRuns).toBe(5);
      expect(report.summary.baselineEmptyRunRatio).toBe(50);
      expect(report.summary.totalRuns).toBe(10);
      expect(report.summary.emptyRuns).toBe(2);
      expect(report.summary.emptyRunRatio).toBe(20);
      // Reduction from 50% to 20% is ((50 - 20) / 50) * 100 = 60% reduction
      expect(report.summary.reductionPercent).toBe(60);
      expect(report.summary.targetReductionPercent).toBe(30);
      expect(report.summary.reductionTargetMet).toBe(true);
    });
  });
});
