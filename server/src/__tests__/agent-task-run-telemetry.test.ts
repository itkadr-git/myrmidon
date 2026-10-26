import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, litellmCostEvents } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@myrmidon/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@myrmidon/shared/telemetry")>(
    "@myrmidon/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

import { emitAgentTaskRun, buildRunTelemetry } from "../services/agent-task-run-telemetry.ts";

describe("buildRunTelemetry", () => {
  const baseInput = {
    run: {
      id: "run-1",
      agentId: "agent-1",
      invocationSource: "automation",
      triggerDetail: "manual",
      retryOfRunId: null,
      nativeIssueId: null,
      contextSnapshot: {
        issueId: "issue-1",
        wakeReason: "issue_commented",
      },
      usageJson: { inputTokens: 120, cachedInputTokens: 20, outputTokens: 30, model: "gpt-6-luna", billingType: "subscription_included" },
      resultJson: null,
    },
    gatewayCalls: [{ requestId: "gw-1", costCents: 2 }, { requestId: "gw-2", costCents: 3 }],
    reportedCostCents: 5,
    workProducts: [],
  };

  it("correlates trigger, issue, retry, model calls, token totals and gateway spend", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      run: { ...baseInput.run, retryOfRunId: "parent-run" },
      issueUpdatedAt: new Date("2026-10-26T16:00:00.000Z"),
      modelApiPricing: {
        "gpt-6-luna": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5 },
      },
      wakeup: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        payload: { sourceEventId: "source-event-7", sourceSeq: 7 },
      },
      workProducts: [{ type: "artifact" }],
    });

    expect(telemetry).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      eventRevision: "2026-10-26T16:00:00.000Z",
      sourceEventId: "source-event-7",
      sourceEventSeq: 7,
      parentRunId: "parent-run",
      retryOfRunId: "parent-run",
      modelCallCount: 2,
      litellmRequestIds: ["gw-1", "gw-2"],
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      gatewaySpendCents: 5,
      reportedCostCents: 5,
      apiEquivalentCostUsd: 0.000025,
      apiEquivalentCostMicros: 25,
      apiEquivalentCostStatus: "estimated",
      outcomeCategory: "artifact",
      artifactCount: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("prompt");
    expect(telemetry).not.toHaveProperty("statusChangeCount");
    expect(telemetry).not.toHaveProperty("commentCount");
  });

  it("preserves gateway IDs separately from LiteLLM spend request IDs", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      run: {
        ...baseInput.run,
        resultJson: { gatewayCallIds: ["gw-call-1", "gw-call-2"], modelCallCount: 3 },
      },
      gatewayCalls: [{ requestId: "litellm-req-1", costCents: 4 }],
    });
    expect(telemetry.gatewayCallIds).toEqual(["gw-call-1", "gw-call-2"]);
    expect(telemetry.litellmRequestIds).toEqual(["litellm-req-1"]);
    expect(telemetry.modelCallCount).toBe(3);
    expect(telemetry.modelCallCountSource).toBe("gateway_count");
  });

  it("uses issues.updatedAt as the event revision and leaves it absent when no issue row exists", () => {
    const telemetry = buildRunTelemetry(baseInput);
    expect(telemetry.eventRevision).toBeNull();
    expect(telemetry.sourceEventId).toBeNull();
    expect(telemetry.sourceEventSeq).toBeNull();
  });

  it("classifies registered commit and push work products", () => {
    const commit = buildRunTelemetry({
      ...baseInput,
      workProducts: [{ type: "commit" }],
    });
    expect(commit.outcomeCategory).toBe("commit_push");
    expect(commit.commitCount).toBe(1);
    const pushed = buildRunTelemetry({ ...baseInput, workProducts: [{ type: "pull_request" }] });
    expect(pushed.outcomeCategory).toBe("commit_push");
    expect(pushed.pullRequestCount).toBe(1);

    expect(buildRunTelemetry(baseInput).outcomeCategory).toBeNull();
  });

  it("classifies only registered work products", () => {
    const doc = buildRunTelemetry({ ...baseInput, workProducts: [{ type: "document" }] });
    expect(doc.outcomeCategory).toBe("other_work_product");
    expect(doc.documentCount).toBe(1);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("emitAgentTaskRun", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-task-run-telemetry-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(litellmCostEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(
    agentOverrides: Partial<typeof agents.$inferInsert> = {},
  ) {
    companyId = randomUUID();
    agentId = randomUUID();
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
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      ...agentOverrides,
    });
    return { companyId, agentId };
  }

  it("persists a snapshot joined to the wake receipt and LiteLLM requests", async () => {
    await seedCompanyAndAgent();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const issueUpdatedAt = new Date("2026-10-26T16:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Telemetry fixture",
      updatedAt: issueUpdatedAt,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "callback",
      reason: "issue_commented",
      payload: { issueId, sourceEventId: "comment-12", sourceSeq: 12 },
      status: "completed",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "callback",
      status: "succeeded",
      wakeupRequestId,
      contextSnapshot: { issueId },
      usageJson: {
        model: "gpt-6-luna",
        billingType: "subscription_included",
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
      },
      resultJson: { gatewayCallIds: ["gateway-call-12"] },
    });
    await db.insert(litellmCostEvents).values({
      id: `${companyId}:request-12`,
      companyId,
      agentId,
      issueId,
      heartbeatRunId: runId,
      provider: "litellm",
      model: "gpt-6-luna",
      costCents: 7,
      occurredAt: new Date("2026-10-26T00:00:00Z"),
      requestId: "request-12",
    });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    await emitAgentTaskRun(db, run);
    const saved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);

    expect(saved.resultJson?.runTelemetry).toMatchObject({
      runId,
      agentId,
      issueId,
      wakeSource: "automation",
      wakeTriggerDetail: "callback",
      eventRevision: issueUpdatedAt.toISOString(),
      wakeReason: "issue_commented",
      sourceEventId: "comment-12",
      sourceEventSeq: 12,
      gatewayCallIds: ["gateway-call-12"],
      litellmRequestIds: ["request-12"],
      gatewaySpendCents: 7,
      apiEquivalentCostUsd: 0.000025,
      outcomeCategory: null,
    });
  });

  it("emits one agent.task_run event for each of the five terminal states", async () => {
    await seedCompanyAndAgent();
    const states = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
    for (const state of states) {
      mockTrackAgentTaskRun.mockClear();
      const runId = randomUUID();
      const run = {
        id: runId,
        companyId,
        agentId,
        status: state,
        startedAt: null,
        finishedAt: null,
        usageJson: null,
        contextSnapshot: null,
      } as unknown as typeof heartbeatRuns.$inferSelect;

      await emitAgentTaskRun(db, run);

      expect(mockTrackAgentTaskRun).toHaveBeenCalledTimes(1);
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({ agentId, state }),
      );
    }
  });

  it("omits durationSeconds when the run has no startedAt", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("durationSeconds");
  });

  it("sends whole seconds from startedAt to finishedAt", async () => {
    await seedCompanyAndAgent();
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const finishedAt = new Date("2026-01-01T00:00:07.400Z");
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt,
      finishedAt,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.durationSeconds).toBe(7);
    expect(Number.isInteger(dims.durationSeconds)).toBe(true);
  });

  it("never returns a negative durationSeconds when finishedAt precedes startedAt", async () => {
    await seedCompanyAndAgent();
    const startedAt = new Date("2026-01-01T00:00:10.000Z");
    const finishedAt = new Date("2026-01-01T00:00:05.000Z");
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "cancelled",
      startedAt,
      finishedAt,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.durationSeconds).toBe(0);
  });

  it("omits model, the three token dimensions, and taskId when each source is absent", async () => {
    await seedCompanyAndAgent({ adapterConfig: {} });
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "failed",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("model");
    expect(dims).not.toHaveProperty("inputTokens");
    expect(dims).not.toHaveProperty("outputTokens");
    expect(dims).not.toHaveProperty("cachedTokens");
    expect(dims).not.toHaveProperty("taskId");
  });

  it("sends cachedTokens: 0 when usage exists and carries no cached value", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: { inputTokens: 12, outputTokens: 34 },
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.inputTokens).toBe(12);
    expect(dims.outputTokens).toBe(34);
    expect(dims.cachedTokens).toBe(0);
  });

  it("emits with no taskId when contextSnapshot carries no issueId", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: { wakeReason: "issue_commented" },
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("taskId");
  });

  it("passes the raw task identifier to trackAgentTaskRun without hashing it", async () => {
    await seedCompanyAndAgent();
    const rawIssueId = randomUUID();
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: { issueId: rawIssueId },
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims.taskId).toBe(rawIssueId);
    expect(dims.taskId).not.toMatch(/^[0-9a-f]{32}$/);
  });

  it("does not throw out of the status write when the emit fails", async () => {
    await seedCompanyAndAgent();
    mockTrackAgentTaskRun.mockImplementationOnce(() => {
      throw new Error("telemetry backend unreachable");
    });
    const run = {
      id: randomUUID(),
      companyId,
      agentId,
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await expect(emitAgentTaskRun(db, run)).resolves.toBeUndefined();
  });

  it("omits adapterType and agentRole when the agent row is absent", async () => {
    await seedCompanyAndAgent();
    const run = {
      id: randomUUID(),
      companyId,
      agentId: randomUUID(),
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      usageJson: null,
      contextSnapshot: null,
    } as unknown as typeof heartbeatRuns.$inferSelect;

    await emitAgentTaskRun(db, run);

    const dims = mockTrackAgentTaskRun.mock.calls[0][1];
    expect(dims).not.toHaveProperty("adapterType");
    expect(dims).not.toHaveProperty("agentRole");
  });
});
