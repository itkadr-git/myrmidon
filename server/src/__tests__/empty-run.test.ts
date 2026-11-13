import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  type Db,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import type * as adaptersModule from "../adapters/index.ts";

// The settlement path must run through the real dispatch/settlement pipeline
// without invoking the real codex_local adapter (which needs a local agent
// JWT). The stub returns an empty summary, so the run settles as
// `empty_response` and the empty-run streak escalation sees the same input a
// genuinely empty agent answer produces.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof adaptersModule>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});
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
import * as heartbeatEvents from "../services/heartbeat-run-events.js";

/**
 * Instance contract of the heartbeat service factory, named here because the
 * owning module (`server/src/services/heartbeat.ts`) does not export one yet.
 * Once the service exports `HeartbeatService`, import that instead.
 */
type HeartbeatServiceInstance = ReturnType<typeof heartbeatService>;

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

// OPE-12941 (review): exercise the real settlement path
// (executeRun → handleSuccessfulRunHandoff → checkAndHandleEmptyRunEscalation →
// agent_wakeup_requests receipt) over an embedded Postgres, so the persisted
// skipped receipt — status `skipped`, reason `empty_run_streak`, run link —
// is proven against the actual DB write, not the mocked helper chain.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres empty-run schedule-path tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("empty-run escalation through the schedule settlement path", () => {
  let db!: Db;
  let heartbeat!: HeartbeatServiceInstance;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-empty-run-schedule-path-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    // Post-run bookkeeping can still write for a moment after a run reaches a
    // terminal status, so a single delete sweep can hit a foreign-key violation
    // when a late insert lands between two deletes. Retry the sweep, pacing with
    // the drain's own awaitable signal (it returns once no run or wakeup is
    // in flight) instead of a wall-clock sleep.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(instanceSettings);
        await db.delete(companySkills);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        teamLiveness: { idlePickup: false },
      },
      runtimeConfig: {
        heartbeat: {
          // A timer-sourced scheduler wake is admitted only when the agent's
          // heartbeat policy is enabled (parseHeartbeatPolicy defaults it to
          // false), so the settlement path test opts the agent into the timer.
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Empty-run streak schedule path",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    livenessState?: string;
    livenessReason?: string;
    finishedSecondsAgo: number;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = new Date(finishedAt.getTime() - 5_000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      livenessState: input.livenessState ?? null,
      livenessReason: input.livenessReason ?? null,
      contextSnapshot: { issueId: input.issueId, wakeReason: "heartbeat_timer" },
    });
    return runId;
  }

  async function latestSkippedWakeup(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        payload: agentWakeupRequests.payload,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .where(
        sql`${agentWakeupRequests.agentId} = ${agentId} and ${agentWakeupRequests.status} = 'skipped' and ${agentWakeupRequests.reason} = 'empty_run_streak'`,
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  it("persists a skipped empty_run_streak receipt linked to the settled run when a timer-triggered empty run reaches the threshold", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    // Streak history: the threshold is 5, so 4 seeded empty terminal runs plus
    // the run under settlement complete the streak on the real schedule path.
    for (let i = 4; i >= 1; i -= 1) {
      await seedTerminalRun({
        companyId,
        agentId,
        issueId,
        livenessState: "empty_response",
        livenessReason: "Run succeeded without useful output",
        finishedSecondsAgo: i * 10,
      });
    }

    const wake = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        issueId,
      },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    expect(wake).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // TEMP-DEBUG
    const debugRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    console.warn("TEMP-DEBUG runs:", JSON.stringify(debugRuns.map((r) => ({ id: r.id, status: r.status, livenessState: r.livenessState, livenessReason: r.livenessReason, issueCommentStatus: r.issueCommentStatus, errorCode: r.errorCode, continuationAttempt: r.continuationAttempt, contextSnapshot: r.contextSnapshot }))));
    const debugWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    console.warn("TEMP-DEBUG wakes:", JSON.stringify(debugWakes.map((w) => ({ id: w.id, status: w.status, reason: w.reason, runId: w.runId, payload: w.payload }))));
    const debugComments = await db.select({ body: issueComments.body, runId: issueComments.createdByRunId }).from(issueComments).where(eq(issueComments.issueId, issueId));
    console.warn("TEMP-DEBUG comments:", JSON.stringify(debugComments));
    const debugSettings = await db.select().from(instanceSettings);
    console.warn("TEMP-DEBUG settings:", JSON.stringify(debugSettings));

    const receipt = await latestSkippedWakeup(agentId);
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe("skipped");
    expect(receipt?.reason).toBe("empty_run_streak");
    // The receipt must link to the actual settled run so the per-run SKIPPED
    // reason is traceable without correlating timestamps.
    const settledRuns = await db
      .select({ id: heartbeatRuns.id, livenessState: heartbeatRuns.livenessState })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(settledRuns.some((run) => run.id === receipt?.runId)).toBe(true);
    expect(settledRuns.find((run) => run.id === receipt?.runId)?.livenessState).toBe("empty_response");
    const heartbeatSkip = (receipt?.payload as Record<string, unknown> | null)?.heartbeatSkip as
      | Record<string, unknown>
      | undefined;
    expect(heartbeatSkip?.reason).toBe("empty_run_streak");
    expect(heartbeatSkip?.streak).toBe(5);
    expect(heartbeatSkip?.threshold).toBe(5);
    expect(heartbeatSkip?.lastRunId).toBe(receipt?.runId);
    // The streak signal is also visible on the settled run's log.
    const streakEvents = await db
      .select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(sql`${heartbeatRunEvents.runId} = ${receipt?.runId} and ${heartbeatRunEvents.eventType} = ${AUTOPAUSE_EMPTY_STREAK_EVENT}`);
    expect(streakEvents).toHaveLength(1);
    expect(streakEvents[0]?.payload).toMatchObject({ reason: "empty_run_streak", streak: 5, threshold: 5 });
    // The empty run itself must not have been re-labelled as a productive handoff:
    // no corrective FINISH_SUCCESSFUL_RUN_HANDOFF wake may exist for it.
    const handoffWakes = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        sql`${agentWakeupRequests.agentId} = ${agentId} and ${agentWakeupRequests.payload} ->> 'sourceRunId' = ${receipt?.runId}`,
      );
    expect(handoffWakes[0]?.count ?? 0).toBe(0);
  });

  it("starts a fresh streak when a productive run sits between the two empty-run stretches on the schedule path", async () => {
    const { companyId, agentId, issueId } = await seedCompanyAgentIssue();

    // Newest 3 empty runs; the productive run breaks the streak; 5 older empty
    // runs predate it and must never be inherited (streak restarts at 1).
    for (let i = 4; i >= 2; i -= 1) {
      await seedTerminalRun({
        companyId,
        agentId,
        issueId,
        livenessState: "empty_response",
        livenessReason: "Run succeeded without useful output",
        finishedSecondsAgo: i * 10,
      });
    }
    await seedTerminalRun({
      companyId,
      agentId,
      issueId,
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 activity event(s)",
      finishedSecondsAgo: 20,
    });
    for (let i = 5; i <= 9; i += 1) {
      await seedTerminalRun({
        companyId,
        agentId,
        issueId,
        livenessState: "empty_response",
        livenessReason: "Run succeeded without useful output",
        finishedSecondsAgo: i * 10,
      });
    }

    const wake = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        issueId,
      },
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
    });
    expect(wake).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const receipt = await latestSkippedWakeup(agentId);
    expect(receipt).toBeNull();
    const streakEvents = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRunEvents)
      .where(sql`${heartbeatRunEvents.eventType} = ${AUTOPAUSE_EMPTY_STREAK_EVENT}`);
    expect(streakEvents[0]?.count ?? 0).toBe(0);
  });
});
