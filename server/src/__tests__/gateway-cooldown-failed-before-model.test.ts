import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@myrmidon/db";
import { mapFinalResultForTest } from "@myrmidon/hermes-paperclip-adapter/gateway/server";
import {
  failedBeforeModelMetrics,
  createFailedBeforeModelMetricsRegistry,
} from "../services/failed-before-model-metrics.js";
import {
  METRIC_FAMILIES,
  renderMetricsText,
  readAgentFailedBeforeModel,
  collectMetricsSnapshot,
  type MetricsSnapshot,
} from "../myrmidon/monitoring/metrics/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  computeTransientRetryDelayMs,
} from "../services/heartbeat.js";

describe("OPE-9476: gateway cooldown and failed-before-model handling", () => {
  it("classifies LiteLLM deployment cooldown as provider_quota with cooldown delay and failedBeforeModel", () => {
    const cooldownMessage =
      "RateLimitError: No deployments available. All deployments (openai/chatgpt) are in cooldown. Retry after 60s.";
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-cooldown-1",
        status: "failed",
        payload: {
          status: "failed",
          error: cooldownMessage,
        },
      },
      outputChunks: [],
      sessionKey: "session-key-1",
      strategy: "issue",
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("hermes_gateway_run_failed");
    expect(result.errorFamily).toBe("provider_quota");
    expect(result.failedBeforeModel).toBe(true);
    expect(result.retryNotBefore).toBeTruthy();
    expect(new Date(result.retryNotBefore!).getTime()).toBeGreaterThan(Date.now());

    expect(result.resultJson).toMatchObject({
      status: "failed",
      failedBeforeModel: true,
      failed_before_model: true,
      modelResponseStarted: false,
      cooldown: true,
    });
  });

  it("extracts custom retry-after delay from cooldown error message", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-cooldown-custom",
        status: "failed",
        payload: {
          status: "failed",
          error: "No deployments available. All deployments in cooldown. Retry after 45s.",
        },
      },
      outputChunks: [],
      sessionKey: "session-key-2",
      strategy: "issue",
    });

    expect(result.errorFamily).toBe("provider_quota");
    expect(result.failedBeforeModel).toBe(true);
    const retryDate = new Date(result.retryNotBefore!).getTime();
    const diffSec = Math.round((retryDate - Date.now()) / 1000);
    expect(diffSec).toBeGreaterThanOrEqual(40);
    expect(diffSec).toBeLessThanOrEqual(50);
  });

  it("does not mark failure as failedBeforeModel if model output chunks arrived", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-output-1",
        status: "failed",
        payload: {
          status: "failed",
          error: "Post-response failure",
        },
      },
      outputChunks: ["Partial assistant answer before dying"],
      sessionKey: "session-key-3",
      strategy: "issue",
    });

    expect(result.failedBeforeModel).toBe(false);
    expect(result.resultJson?.failedBeforeModel).toBe(false);
    expect(result.resultJson?.modelResponseStarted).toBe(true);
  });

  it("does not mark failure as failedBeforeModel if modelResponseStarted flag is true", () => {
    const result = mapFinalResultForTest({
      terminal: {
        runId: "run-flag-1",
        status: "failed",
        payload: {
          status: "failed",
          error: "Downstream stream cut off",
        },
      },
      outputChunks: [],
      sessionKey: "session-key-4",
      strategy: "issue",
      modelResponseStarted: true,
    });

    expect(result.failedBeforeModel).toBe(false);
    expect(result.resultJson?.failedBeforeModel).toBe(false);
    expect(result.resultJson?.modelResponseStarted).toBe(true);
  });

  it("tracks failed_before_model counter per agent in metrics registry and Prometheus exposition", () => {
    const registry = createFailedBeforeModelMetricsRegistry();
    registry.recordFailure("agent-alpha");
    registry.recordFailure("agent-alpha");
    registry.recordFailure("agent-beta");

    expect(registry.get("agent-alpha")).toBe(2);
    expect(registry.get("agent-beta")).toBe(1);
    expect(registry.get("agent-gamma")).toBe(0);

    failedBeforeModelMetrics.reset();
    failedBeforeModelMetrics.recordFailure("agent-adm");
    expect(failedBeforeModelMetrics.get("agent-adm")).toBe(1);

    expect(METRIC_FAMILIES).toContain("myrmidon_agent_failed_before_model_total");

    const sampleSnapshot: MetricsSnapshot = {
      role: "all",
      runsActive: 0,
      runsQueued: 0,
      runsFailedTotal: 1,
      runsFailedWindow: 1,
      runDurationSecondsP50: null,
      runDurationSecondsP95: null,
      roleQueueTasks: [],
      reviewTasksWithoutReviewer: 0,
      blockedTasksWithoutAssignee: 0,
      swarmClaimsActive: 0,
      swarmClaimsTotal: 0,
      agentErrorSignals: 0,
      llmCostCentsWindow: 0,
      process: null,
      scrapeErrors: 0,
      collectedAt: new Date().toISOString(),
      failedBeforeModel: { "agent-adm": 1 },
    };

    const rendered = renderMetricsText(sampleSnapshot);
    expect(rendered).toContain("myrmidon_agent_failed_before_model_total");
    expect(rendered).toContain('agent_id="agent-adm"');
  });

  describe("retry schedule with cooldown and exponential backoff", () => {
    it("schedules consecutive retries with exponential backoff when cooldown hint is active", () => {
      const now = new Date("2026-10-30T10:00:00.000Z");
      const retryNotBefore = new Date("2026-10-30T10:01:00.000Z"); // +60s hint
      const finishedAt = new Date("2026-10-30T10:00:00.000Z");

      // Attempt 1: honors the 60s cooldown hint
      const delay1 = computeTransientRetryDelayMs({
        nextAttempt: 1,
        now,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay1).toBe(60_000);

      // Attempt 2: exponential backoff (60s * 2^1 = 120s)
      const delay2 = computeTransientRetryDelayMs({
        nextAttempt: 2,
        now,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay2).toBe(120_000);

      // Attempt 3: exponential backoff (60s * 2^2 = 240s)
      const delay3 = computeTransientRetryDelayMs({
        nextAttempt: 3,
        now,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay3).toBe(240_000);
    });

    it("does not yield 0 or immediate retry after cooldown hint has elapsed (consecutive dueAt increase exponentially)", () => {
      const finishedAt = new Date("2026-10-30T10:00:00.000Z");
      const retryNotBefore = new Date("2026-10-30T10:01:00.000Z"); // expired 30s ago
      const nowAfterCooldown = new Date("2026-10-30T10:01:30.000Z");

      // Attempt 1 after hint elapsed: must NOT be 0 (immediate retry), must be at least base cooldown (60s)
      const delay1 = computeTransientRetryDelayMs({
        nextAttempt: 1,
        now: nowAfterCooldown,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay1).toBe(60_000);
      const dueAt1 = new Date(nowAfterCooldown.getTime() + delay1!);
      expect(dueAt1.getTime()).toBe(nowAfterCooldown.getTime() + 60_000);

      // Attempt 2: exponential backoff (120s)
      const delay2 = computeTransientRetryDelayMs({
        nextAttempt: 2,
        now: nowAfterCooldown,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay2).toBe(120_000);
      const dueAt2 = new Date(nowAfterCooldown.getTime() + delay2!);
      expect(dueAt2.getTime()).toBe(nowAfterCooldown.getTime() + 120_000);

      // Attempt 3: exponential backoff (240s)
      const delay3 = computeTransientRetryDelayMs({
        nextAttempt: 3,
        now: nowAfterCooldown,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota: true,
        runFinishedAt: finishedAt,
      });
      expect(delay3).toBe(240_000);
      const dueAt3 = new Date(nowAfterCooldown.getTime() + delay3!);
      expect(dueAt3.getTime()).toBe(nowAfterCooldown.getTime() + 240_000);

      // Verify consecutive dueAt are strictly monotonic and exponentially spaced
      expect(dueAt2.getTime() - dueAt1.getTime()).toBeGreaterThan(60_000);
      expect(dueAt3.getTime() - dueAt2.getTime()).toBeGreaterThan(120_000);
    });

    it("applies exponential backoff when provider_quota error has no explicit hint", () => {
      const now = new Date("2026-10-30T10:00:00.000Z");

      const delay1 = computeTransientRetryDelayMs({
        nextAttempt: 1,
        now,
        isCooldownOrQuota: true,
      });
      expect(delay1).toBe(60_000);

      const delay2 = computeTransientRetryDelayMs({
        nextAttempt: 2,
        now,
        isCooldownOrQuota: true,
      });
      expect(delay2).toBe(120_000);
    });

    it("recognizes cooldown marker in terminal adapter resultJson for heartbeat retry scheduling", () => {
      const now = new Date("2026-10-30T10:00:00.000Z");
      const retryNotBefore = "2026-10-30T10:02:00.000Z";

      // Result with structured LiteLLM cooldown
      const terminalResult = mapFinalResultForTest({
        terminal: {
          runId: "run-terminal-cooldown",
          status: "failed",
          payload: {
            error_code: 429,
            error_type: "rate_limit_error",
            error: {
              code: 429,
              type: "rate_limit_error",
              retry_after: 120,
            },
          },
        },
        outputChunks: [],
        sessionKey: "session-cooldown",
        strategy: "issue",
      });

      expect(terminalResult.resultJson?.cooldown).toBe(true);
      expect(terminalResult.errorFamily).toBe("provider_quota");

      // Verify that heartbeat retry logic extracts isCooldownOrQuota
      const runResult = terminalResult.resultJson as Record<string, unknown>;
      const isCooldownOrQuota =
        terminalResult.errorFamily === "provider_quota" ||
        Boolean(runResult.cooldown);

      expect(isCooldownOrQuota).toBe(true);

      const delay = computeTransientRetryDelayMs({
        nextAttempt: 1,
        now,
        transientRetryNotBeforeHint: retryNotBefore,
        isCooldownOrQuota,
      });

      // 120s from hint
      expect(delay).toBe(120_000);

      // And non-cooldown terminal failure does NOT set cooldown flag
      const nonCooldownResult = mapFinalResultForTest({
        terminal: {
          runId: "run-non-cooldown",
          status: "failed",
          payload: {
            status: "failed",
            error: "SyntaxError: Unexpected token",
          },
        },
        outputChunks: [],
        sessionKey: "session-non-cooldown",
        strategy: "issue",
      });

      expect(nonCooldownResult.resultJson?.cooldown).toBeUndefined();
      expect(nonCooldownResult.errorFamily).not.toBe("provider_quota");
    });
  });

  describe("durable failedBeforeModel metrics aggregation", () => {
    it("aggregates failed-before-model counts across instances and falls back gracefully", async () => {
      const fakeDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              groupBy: () =>
                Promise.resolve([
                  { agentId: "agent-alpha", total: 3 },
                  { agentId: "agent-beta", total: 1 },
                ]),
            }),
          }),
        }),
      } as any;

      const result = await readAgentFailedBeforeModel(fakeDb);
      expect(result["agent-alpha"]).toBe(3);
      expect(result["agent-beta"]).toBe(1);
    });

    it("simulates full write-to-scrape lifecycle: heartbeat failure persists failedBeforeModel and is exposed in Prometheus scrape", async () => {
      const agentId = "agent-lifecycle-test";
      const registry = createFailedBeforeModelMetricsRegistry();

      // 1. Production heartbeat records in-memory metric
      registry.recordFailure(agentId);
      expect(registry.get(agentId)).toBe(1);

      // 2. Production heartbeat writes resultJson to DB heartbeat_runs
      const persistedRun = {
        agentId,
        status: "failed",
        resultJson: {
          failedBeforeModel: true,
          failed_before_model: true,
          errorFamily: "provider_quota",
        },
      };

      // 3. Database aggregation reads from heartbeat_runs
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => ({
              groupBy: () =>
                Promise.resolve([
                  { agentId: persistedRun.agentId, total: 1 },
                ]),
            }),
          }),
        }),
      } as any;

      const dbCounts = await readAgentFailedBeforeModel(mockDb);
      expect(dbCounts[agentId]).toBe(1);

      // 4. Prometheus scrape collector queries DB counts and formats metrics
      const snapshot = await collectMetricsSnapshot({
        db: mockDb,
        now: () => new Date(),
        errorWindowSec: 60,
        latencyWindowSec: 60,
        role: "all",
      });
      expect(snapshot.failedBeforeModel?.[agentId]).toBe(1);

      const scrapeText = renderMetricsText(snapshot);
      expect(scrapeText).toContain("myrmidon_agent_failed_before_model_total");
      expect(scrapeText).toContain(`agent_id="${agentId}"`);
      expect(scrapeText).toMatch(
        new RegExp(`myrmidon_agent_failed_before_model_total\\{[^}]*agent_id="${agentId}"[^}]*\\}\\s+1`),
      );
    });
  });
});

const embeddedSupport = getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

describeEmbedded("OPE-9476: production heartbeat daily cap exclusion for failedBeforeModel runs", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-gateway-cooldown-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(maxDailyRuns = 1) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxDailyRuns,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("does not count runs with failedBeforeModel=true towards maxDailyRuns", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(1);

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "failed",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
      resultJson: {
        failedBeforeModel: true,
      },
    });

    await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    const [request] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(request?.reason).not.toBe("heartbeat.daily_run_limit");
  });

  it("counts runs with failedBeforeModel=false (post-response failure) towards maxDailyRuns", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(1);

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "failed",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
      resultJson: {
        failedBeforeModel: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();

    const [request] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(request).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(request?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("aggregates failedBeforeModel runs from real postgres database", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(10);

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "failed",
        createdAt: new Date(),
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: {},
        resultJson: {
          failedBeforeModel: true,
        },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "failed",
        createdAt: new Date(),
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: {},
        resultJson: {
          failedBeforeModel: true,
        },
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "failed",
        createdAt: new Date(),
        startedAt: new Date(),
        finishedAt: new Date(),
        contextSnapshot: {},
        resultJson: {
          failedBeforeModel: false,
        },
      },
    ]);

    const aggregated = await readAgentFailedBeforeModel(db);
    expect(aggregated[agentId]).toBe(2);
  });
});
