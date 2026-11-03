import childProcess from \"node:child_process\";
import { describe, expect, it, vi } from \"vitest\";
import {
  DETECT_STUCK_RUNS_TOOL_NAME,
  detectStuckRuns,
  detectStuckRunsTool,
  detectStuckRunsToolDefinition,
  detectStuckRunsToolSchema,
  determineRecoveryAction,
  executeDetectStuckRuns,
  type DetectStuckRunsResult,
  type StuckRunItem,
  type StuckRunsProvider,
} from \"./stuck-runs.js\";

describe(\"detect_stuck_runs tool\", () => {
  describe(\"LiteLLM function calling schema\", () => {
    it(\"exports the expected tool name\", () => {
      expect(DETECT_STUCK_RUNS_TOOL_NAME).toBe(\"detect_stuck_runs\");
      expect(detectStuckRunsTool.name).toBe(\"detect_stuck_runs\");
    });

    it(\"matches OpenAI / LiteLLM function calling tool specification\", () => {
      expect(detectStuckRunsToolDefinition.type).toBe(\"function\");
      expect(detectStuckRunsToolDefinition.function.name).toBe(\"detect_stuck_runs\");
      expect(detectStuckRunsToolDefinition.function.description).toContain(\"Detects in_progress tasks\");
      expect(detectStuckRunsToolDefinition.function.parameters.type).toBe(\"object\");
      expect(detectStuckRunsToolDefinition.function.parameters.properties).toHaveProperty(\"timeoutMs\");
      expect(detectStuckRunsToolDefinition.function.parameters.properties).toHaveProperty(\"companyId\");
    });

    it(\"provides detectStuckRunsToolSchema alias\", () => {
      expect(detectStuckRunsToolSchema).toBe(detectStuckRunsToolDefinition);
    });
  });

  describe(\"Safe execution without direct shell command invocation\", () => {
    it(\"does not call any child_process shell functions during execution\", async () => {
      const execSpy = vi.spyOn(childProcess, \"exec\");
      const execSyncSpy = vi.spyOn(childProcess, \"execSync\");
      const spawnSpy = vi.spyOn(childProcess, \"spawn\");
      const spawnSyncSpy = vi.spyOn(childProcess, \"spawnSync\");

      const result = await executeDetectStuckRuns();

      expect(execSpy).not.toHaveBeenCalled();
      expect(execSyncSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();

      execSpy.mockRestore();
      execSyncSpy.mockRestore();
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe(\"Recovery action determination policy\", () => {
    const timeoutMs = 300_000; // 5 minutes

    it(\"suggests restart (рестарт) for active running processes silent within 3x timeout\", () => {
      const recommendation = determineRecoveryAction({
        silenceMs: 600_000, // 10 minutes (2x timeout)
        timeoutMs,
        runStatus: \"running\",
        hasLock: false,
      });

      expect(recommendation.suggestedAction).toBe(\"рестарт\");
      expect(recommendation.action).toBe(\"рестарт\");
      expect(recommendation.actionCode).toBe(\"restart\");
    });

    it(\"suggests unblock (разблокировка) when task is locked with terminated or blocked run\", () => {
      const recommendation = determineRecoveryAction({
        silenceMs: 400_000,
        timeoutMs,
        runStatus: \"failed\",
        hasLock: true,
      });

      expect(recommendation.suggestedAction).toBe(\"разблокировка\");
      expect(recommendation.action).toBe(\"разблокировка\");
      expect(recommendation.actionCode).toBe(\"unblock\");
    });

    it(\"suggests unblock (разблокировка) when run status is explicitly blocked\", () => {
      const recommendation = determineRecoveryAction({
        silenceMs: 400_000,
        timeoutMs,
        runStatus: \"blocked\",
        hasLock: false,
      });

      expect(recommendation.suggestedAction).toBe(\"разблокировка\");
      expect(recommendation.actionCode).toBe(\"unblock\");
    });

    it(\"suggests escalation (эскалация) when silence is critical (>= 3x timeout)\", () => {
      const recommendation = determineRecoveryAction({
        silenceMs: 1_200_000, // 20 minutes (>= 3x 5m)
        timeoutMs,
        runStatus: \"running\",
        hasLock: false,
      });

      expect(recommendation.suggestedAction).toBe(\"эскалация\");
      expect(recommendation.action).toBe(\"эскалация\");
      expect(recommendation.actionCode).toBe(\"escalate\");
    });

    it(\"suggests escalation (эскалация) when agent is in error status\", () => {
      const recommendation = determineRecoveryAction({
        silenceMs: 400_000,
        timeoutMs,
        runStatus: \"running\",
        hasLock: false,
        agentStatus: \"error\",
      });

      expect(recommendation.suggestedAction).toBe(\"эскалация\");
      expect(recommendation.actionCode).toBe(\"escalate\");
    });
  });

  describe(\"Test database with stuck records\", () => {
    const fixedNow = new Date(\"2026-11-03T12:00:00.000Z\");
    const timeoutMs = 300_000; // 5 minutes

    const testDb = {
      issues: [
        // 1. Stuck task: running process silent for 10 min -> action: рестарт
        {
          id: \"task-restart-1\",
          identifier: \"OPE-101\",
          title: \"Stuck running task\",
          status: \"in_progress\",
          assigneeAgentId: \"agent-dev-1\",
          executionRunId: \"run-restart-1\",
          companyId: \"comp-1\",
          executionLockedAt: null,
          updatedAt: new Date(\"2026-11-03T11:50:00.000Z\"),
        },
        // 2. Stuck task: locked with failed/missing process silent for 8 min -> action: разблокировка
        {
          id: \"task-unblock-2\",
          identifier: \"OPE-102\",
          title: \"Locked orphaned task\",
          status: \"in_progress\",
          assigneeAgentId: \"agent-dev-2\",
          executionRunId: \"run-unblock-2\",
          companyId: \"comp-1\",
          executionLockedAt: new Date(\"2026-11-03T11:52:00.000Z\"),
          updatedAt: new Date(\"2026-11-03T11:52:00.000Z\"),
        },
        // 3. Stuck task: silence >= 3x timeout (25 min) -> action: эскалация
        {
          id: \"task-escalate-3\",
          identifier: \"OPE-103\",
          title: \"Critically dead task\",
          status: \"in_progress\",
          assigneeAgentId: \"agent-dev-3\",
          executionRunId: \"run-escalate-3\",
          companyId: \"comp-1\",
          executionLockedAt: null,
          updatedAt: new Date(\"2026-11-03T11:35:00.000Z\"),
        },
        // 4. Healthy in-progress task: heartbeat updated 1 minute ago -> NOT stuck
        {
          id: \"task-healthy-4\",
          identifier: \"OPE-104\",
          title: \"Active healthy task\",
          status: \"in_progress\",
          assigneeAgentId: \"agent-dev-4\",
          executionRunId: \"run-healthy-4\",
          companyId: \"comp-1\",
          executionLockedAt: null,
          updatedAt: new Date(\"2026-11-03T11:59:00.000Z\"),
        },
        // 5. Done task with old heartbeat -> NOT in_progress, should be excluded
        {
          id: \"task-done-5\",
          identifier: \"OPE-105\",
          title: \"Finished task\",
          status: \"done\",
          assigneeAgentId: \"agent-dev-1\",
          executionRunId: \"run-done-5\",
          companyId: \"comp-1\",
          executionLockedAt: null,
          updatedAt: new Date(\"2026-11-03T10:00:00.000Z\"),
        },
        // 6. Stuck task belonging to another company -> comp-2
        {
          id: \"task-other-company-6\",
          identifier: \"OPE-106\",
          title: \"Other company task\",
          status: \"in_progress\",
          assigneeAgentId: \"agent-other\",
          executionRunId: \"run-other-6\",
          companyId: \"comp-2\",
          executionLockedAt: null,
          updatedAt: new Date(\"2026-11-03T11:45:00.000Z\"),
        },
      ],
      heartbeatRuns: [
        {
          id: \"run-restart-1\",
          agentId: \"agent-dev-1\",
          status: \"running\",
          lastOutputAt: new Date(\"2026-11-03T11:50:00.000Z\"), // 10m silence (600,000ms)
          updatedAt: new Date(\"2026-11-03T11:50:00.000Z\"),
        },
        {
          id: \"run-unblock-2\",
          agentId: \"agent-dev-2\",
          status: \"failed\",
          lastOutputAt: new Date(\"2026-11-03T11:52:00.000Z\"), // 8m silence (480,000ms)
          updatedAt: new Date(\"2026-11-03T11:52:00.000Z\"),
        },
        {
          id: \"run-escalate-3\",
          agentId: \"agent-dev-3\",
          status: \"running\",
          lastOutputAt: new Date(\"2026-11-03T11:35:00.000Z\"), // 25m silence (1,500,000ms >= 3x 5m)
          updatedAt: new Date(\"2026-11-03T11:35:00.000Z\"),
        },
        {
          id: \"run-healthy-4\",
          agentId: \"agent-dev-4\",
          status: \"running\",
          lastOutputAt: new Date(\"2026-11-03T11:59:00.000Z\"), // 1m silence (60,000ms < 300,000ms)
          updatedAt: new Date(\"2026-11-03T11:59:00.000Z\"),
        },
        {
          id: \"run-done-5\",
          agentId: \"agent-dev-1\",
          status: \"completed\",
          lastOutputAt: new Date(\"2026-11-03T10:00:00.000Z\"),
          updatedAt: new Date(\"2026-11-03T10:00:00.000Z\"),
        },
        {
          id: \"run-other-6\",
          agentId: \"agent-other\",
          status: \"running\",
          lastOutputAt: new Date(\"2026-11-03T11:45:00.000Z\"),
          updatedAt: new Date(\"2026-11-03T11:45:00.000Z\"),
        },
      ],
      agents: [
        { id: \"agent-dev-1\", status: \"idle\" },
        { id: \"agent-dev-2\", status: \"idle\" },
        { id: \"agent-dev-3\", status: \"idle\" },
        { id: \"agent-dev-4\", status: \"active\" },
        { id: \"agent-other\", status: \"idle\" },
      ],
    };

    it(\"returns stuck runs with task ID, agent, silence duration, and suggested action\", async () => {
      const result = await detectStuckRuns(testDb, {
        timeoutMs,
        companyId: \"comp-1\",
        now: fixedNow,
      });

      expect(result).toHaveLength(3);
      expect(result.total).toBe(3);

      const restartRun = result.find((r) => r.issueId === \"task-restart-1\");
      expect(restartRun).toBeDefined();
      expect(restartRun?.taskId).toBe(\"task-restart-1\");
      expect(restartRun?.agentId).toBe(\"agent-dev-1\");
      expect(restartRun?.agent).toBe(\"agent-dev-1\");
      expect(restartRun?.silenceMs).toBe(600_000);
      expect(restartRun?.silenceTime).toBe(600_000);
      expect(restartRun?.suggestedAction).toBe(\"рестарт\");
      expect(restartRun?.action).toBe(\"рестарт\");

      const unblockRun = result.find((r) => r.issueId === \"task-unblock-2\");
      expect(unblockRun).toBeDefined();
      expect(unblockRun?.taskId).toBe(\"task-unblock-2\");
      expect(unblockRun?.agentId).toBe(\"agent-dev-2\");
      expect(unblockRun?.silenceMs).toBe(480_000);
      expect(unblockRun?.suggestedAction).toBe(\"разблокировка\");
      expect(unblockRun?.action).toBe(\"разблокировка\");

      const escalateRun = result.find((r) => r.issueId === \"task-escalate-3\");
      expect(escalateRun).toBeDefined();
      expect(escalateRun?.taskId).toBe(\"task-escalate-3\");
      expect(escalateRun?.agentId).toBe(\"agent-dev-3\");
      expect(escalateRun?.silenceMs).toBe(1_500_000);
      expect(escalateRun?.suggestedAction).toBe(\"эскалация\");
      expect(escalateRun?.action).toBe(\"эскалация\");
    });

    it(\"excludes non-stuck active tasks and completed tasks\", async () => {
      const result = await detectStuckRuns(testDb, {
        timeoutMs,
        companyId: \"comp-1\",
        now: fixedNow,
      });

      const ids = result.map((r) => r.issueId);
      expect(ids).not.toContain(\"task-healthy-4\");
      expect(ids).not.toContain(\"task-done-5\");
    });

    it(\"scopes search by companyId when provided\", async () => {
      const resultComp1 = await detectStuckRuns(testDb, {
        timeoutMs,
        companyId: \"comp-1\",
        now: fixedNow,
      });
      const resultComp2 = await detectStuckRuns(testDb, {
        timeoutMs,
        companyId: \"comp-2\",
        now: fixedNow,
      });

      expect(resultComp1.map((r) => r.issueId)).not.toContain(\"task-other-company-6\");
      expect(resultComp2.map((r) => r.issueId)).toContain(\"task-other-company-6\");
      expect(resultComp2).toHaveLength(1);
    });

    it(\"executes via executeDetectStuckRuns with db option\", async () => {
      const result = await executeDetectStuckRuns(
        { companyId: \"comp-1\", timeoutMs },
        { db: testDb, now: fixedNow },
      );

      expect(result).toHaveLength(3);
      expect(result[0]).toHaveProperty(\"taskId\");
      expect(result[0]).toHaveProperty(\"agentId\");
      expect(result[0]).toHaveProperty(\"silenceMs\");
      expect(result[0]).toHaveProperty(\"suggestedAction\");
    });
  });

  describe(\"Provider and API integration\", () => {
    it(\"delegates to options.provider when supplied\", async () => {
      const mockResult: StuckRunItem[] = [
        {
          issueId: \"task-mock-1\",
          taskId: \"task-mock-1\",
          agentId: \"agent-mock\",
          agent: \"agent-mock\",
          runId: \"run-mock\",
          runStatus: \"running\",
          silenceMs: 400_000,
          silenceTime: 400_000,
          silenceDurationMs: 400_000,
          lastHeartbeatAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          suggestedAction: \"рестарт\",
          action: \"рестарт\",
          actionCode: \"restart\",
          reason: \"Mock test\",
        },
      ];

      const mockProvider: StuckRunsProvider = {
        getStuckRuns: vi.fn().mockResolvedValue(mockResult),
      };

      const result = await executeDetectStuckRuns(
        { companyId: \"comp-test\" },
        { provider: mockProvider },
      );

      expect(mockProvider.getStuckRuns).toHaveBeenCalledWith({
        companyId: \"comp-test\",
        timeoutMs: 300_000,
      });
      expect(result).toHaveLength(1);
      expect(result[0].issueId).toBe(\"task-mock-1\");
      expect(result[0].suggestedAction).toBe(\"рестарт\");
    });

    it(\"fetches from apiBaseUrl when provided\", async () => {
      const fakeRuns: StuckRunItem[] = [
        {
          issueId: \"task-http-1\",
          taskId: \"task-http-1\",
          agentId: \"agent-http\",
          agent: \"agent-http\",
          runId: \"run-http\",
          runStatus: \"running\",
          silenceMs: 700_000,
          silenceTime: 700_000,
          silenceDurationMs: 700_000,
          lastHeartbeatAt: null,
          lastUpdatedAt: null,
          suggestedAction: \"эскалация\",
          action: \"эскалация\",
          actionCode: \"escalate\",
          reason: \"API test\",
        },
      ];

      const fetcher = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ runs: fakeRuns }),
      });

      const result = await executeDetectStuckRuns(
        { timeoutMs: 600_000 },
        { apiBaseUrl: \"http://127.0.0.1:3100\", authToken: \"test-token\", fetcher },
      );

      expect(fetcher).toHaveBeenCalledWith(
        expect.stringContaining(\"http://127.0.0.1:3100/admin-assistant/stuck-runs?timeoutMs=600000\"),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: \"Bearer test-token\",
          }),
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].issueId).toBe(\"task-http-1\");
      expect(result[0].suggestedAction).toBe(\"эскалация\");
    });
  });
});
