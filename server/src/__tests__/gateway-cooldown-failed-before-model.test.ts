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
  type MetricsSnapshot,
} from "../myrmidon/monitoring/metrics/metrics.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

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
});
