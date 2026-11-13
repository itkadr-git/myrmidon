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
  AUTOPAUSE_EMPTY_STREAK_EVENT,
  MAX_REPEATED_TOOL_ERRORS,
} from "../services/empty-run.js";
import type { Db } from "@myrmidon/db";
import * as heartbeatEvents from "../services/heartbeat-run-events.js";

/** Mock of the drizzle select chain the streak check walks; structural cast. */
const historyMockDb = (
  recentRuns: Array<{ id: string; livenessState?: string | null }>,
): Db =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(recentRuns),
          }),
        }),
      }),
    }),
  }) as unknown as Db;

type RunEventInput = Parameters<typeof heartbeatEvents.appendHeartbeatRunEvent>[1];

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
      const db = {} as unknown as Db;
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
      expect(res.skippedSignal).toBeUndefined();
    });

    it("allows rewake when consecutive empty runs are below threshold", async () => {
      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb([{ id: "run-prev-1", livenessState: "empty_response" }]),
        {
          companyId: "comp-1",
          issueId: "issue-1",
          agentId: "agent-1",
          runId: "run-2",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" },
        },
      );

      expect(res.escalated).toBe(false);
      expect(res.consecutiveEmptyRuns).toBe(2);
      expect(res.shouldRewake).toBe(true);
      expect(res.skippedSignal).toBeUndefined();
    });

    it("reaches the maximum configured threshold (20) because the history window scales with the threshold (OPE-12941)", async () => {
      const runEvents: RunEventInput[] = [];
      const spy = vi
        .spyOn(heartbeatEvents, "appendHeartbeatRunEvent")
        .mockImplementation(async (_db, event) => {
          runEvents.push(event);
        });

      // 19 previous empty runs + the current one = streak 20. With the old
      // fixed `.limit(10)` window the counter could only ever reach 11, so
      // thresholds 12..20 were unreachable.
      const previousEmptyRuns = Array.from({ length: 19 }, (_, i) => ({
        id: `run-prev-${i + 1}`,
        livenessState: "empty_response",
      }));
      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb(previousEmptyRuns),
        {
          companyId: "comp-1", issueId: "issue-1", agentId: "agent-1", runId: "run-20",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" },
          threshold: 20,
        },
      );

      expect(res.escalated).toBe(false);
      expect(res.shouldRewake).toBe(true);
      expect(res.consecutiveEmptyRuns).toBe(20);
      expect(res.skippedSignal).toMatchObject({
        reason: "empty_run_streak",
        streak: 20,
        threshold: 20,
        lastRunId: "run-20",
      });
      expect(runEvents).toHaveLength(1);
      spy.mockRestore();
    });

    it("starts a fresh streak when a productive run sits between two empty-run streaks (OPE-12941)", async () => {
      // History newest-first: 3 empty runs, then one productive run, then an
      // older empty streak. The productive run must truncate the count: the
      // next empty run starts at streak 1 (current) + 3 (newest empty block),
      // never inheriting the older streak of 5.
      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb([
          { id: "run-empty-3", livenessState: "empty_response" },
          { id: "run-empty-2", livenessState: "empty_response" },
          { id: "run-empty-1", livenessState: "empty_response" },
          { id: "run-productive", livenessState: "advanced" },
          { id: "run-old-empty-5", livenessState: "empty_response" },
          { id: "run-old-empty-4", livenessState: "empty_response" },
          { id: "run-old-empty-3", livenessState: "empty_response" },
          { id: "run-old-empty-2", livenessState: "empty_response" },
          { id: "run-old-empty-1", livenessState: "empty_response" },
        ]),
        {
          companyId: "comp-1", issueId: "issue-1", agentId: "agent-1", runId: "run-next",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" },
          threshold: 20,
        },
      );

      expect(res.consecutiveEmptyRuns).toBe(4);
      expect(res.skippedSignal).toBeUndefined();
    });

    it("emits a SKIPPED signal with reason after N consecutive empty runs (default threshold 5) without blocking the issue", async () => {
      const runEvents: RunEventInput[] = [];
      const spy = vi
        .spyOn(heartbeatEvents, "appendHeartbeatRunEvent")
        .mockImplementation(async (_db, event) => {
          runEvents.push(event);
        });

      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb([
          { id: "run-prev-4", livenessState: "empty_response" },
          { id: "run-prev-3", livenessState: "empty_response" },
          { id: "run-prev-2", livenessState: "empty_response" },
          { id: "run-prev-1", livenessState: "empty_response" },
        ]),
        {
          companyId: "comp-1",
          issueId: "issue-1",
          agentId: "agent-1",
          runId: "run-5",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" },
        },
      );

      expect(res.escalated).toBe(false);
      expect(res.shouldRewake).toBe(true);
      expect(res.consecutiveEmptyRuns).toBe(5);
      expect(res.skippedSignal).toMatchObject({
        reason: "empty_run_streak",
        streak: 5,
        threshold: 5,
        lastRunId: "run-5",
      });
      expect(runEvents).toHaveLength(1);
      expect(runEvents[0]?.eventType).toBe(AUTOPAUSE_EMPTY_STREAK_EVENT);
      expect(runEvents[0]?.payload).toMatchObject({ reason: "empty_run_streak", streak: 5, threshold: 5 });
      spy.mockRestore();
    });

    it("honors a configured threshold and emits the signal at that streak", async () => {
      const runEvents: RunEventInput[] = [];
      const spy = vi
        .spyOn(heartbeatEvents, "appendHeartbeatRunEvent")
        .mockImplementation(async (_db, event) => {
          runEvents.push(event);
        });
      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb([
          { id: "run-prev-2", livenessState: "empty_response" },
          { id: "run-prev-1", livenessState: "empty_response" },
        ]),
        {
          companyId: "comp-1", issueId: "issue-1", agentId: "agent-1", runId: "run-3",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" }, threshold: 3,
        },
      );
      expect(res.shouldRewake).toBe(true);
      expect(res.skippedSignal?.streak).toBe(3);
      expect(res.skippedSignal?.threshold).toBe(3);
      expect(runEvents[0]?.payload).toMatchObject({ reason: "empty_run_streak", streak: 3, threshold: 3 });
      spy.mockRestore();
    });

    it("does not emit the signal below the configured threshold", async () => {
      const spy = vi.spyOn(heartbeatEvents, "appendHeartbeatRunEvent");
      const res = await checkAndHandleEmptyRunEscalation(
        historyMockDb([{ id: "run-prev-1", livenessState: "empty_response" }]),
        {
          companyId: "comp-1", issueId: "issue-1", agentId: "agent-1", runId: "run-2",
          classification: { isEmpty: true, reason: "empty_response", description: "Empty" },
          gateResult: { passed: false, gateMet: "none", reason: "Gate failed" }, threshold: 5,
        },
      );
      expect(res.skippedSignal).toBeUndefined();
      expect(res.shouldRewake).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("never skips or escalates productive work regardless of the threshold (not a budget cap)", async () => {
      const db = {} as unknown as Db;
      const spy = vi.spyOn(heartbeatEvents, "appendHeartbeatRunEvent");
      for (let i = 0; i < 10; i += 1) {
        const res = await checkAndHandleEmptyRunEscalation(db, {
          companyId: "comp-1", issueId: "issue-1", agentId: "agent-1", runId: "run-prod",
          classification: { isEmpty: false, reason: null, description: "Productive" },
          gateResult: { passed: true, gateMet: "commit_or_pr", reason: "Commit created" }, threshold: 2,
        });
        expect(res.escalated).toBe(false);
        expect(res.shouldRewake).toBe(true);
        expect(res.skippedSignal).toBeUndefined();
        expect(res.consecutiveEmptyRuns).toBe(0);
      }
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
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
      const mockDb = {} as unknown as Db;
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
