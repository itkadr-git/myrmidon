import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@myrmidon/db";
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
      invocationSource: "event",
      triggerDetail: "issue",
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
    activity: [],
    workProducts: [],
    commentCount: 0,
    documentRevisionCount: 0,
  };

  it("correlates trigger, issue, retry, model calls, token totals and gateway spend", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      run: { ...baseInput.run, retryOfRunId: "parent-run" },
      modelApiPricing: {
        "gpt-6-luna": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5 },
      },
      wakeup: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        payload: { eventRevisionId: "revision-7", sourceEventId: "source-event-7", sourceSeq: 7 },
      },
      activity: [{ action: "issue.updated", details: { status: "in_review", previousStatus: "todo" } }],
      commentCount: 1,
    });

    expect(telemetry).toMatchObject({
      runId: "run-1",
      agentId: "agent-1",
      issueId: "issue-1",
      wakeReason: "issue_commented",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      eventRevision: null,
      eventRevisionId: "revision-7",
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
      outcomeCategory: "status",
      commentCount: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("prompt");
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

  it("leaves event revision absent when the wake receipt has no revision", () => {
    const telemetry = buildRunTelemetry(baseInput);
    expect(telemetry.eventRevision).toBeNull();
    expect(telemetry.eventRevisionId).toBeNull();
    expect(telemetry.sourceEventId).toBeNull();
    expect(telemetry.sourceEventSeq).toBeNull();
  });

  it("keeps commits separately classifiable and labels comment-only or empty runs", () => {
    const commit = buildRunTelemetry({
      ...baseInput,
      workProducts: [{ type: "commit" }],
      commentCount: 1,
    });
    expect(commit.outcomeCategory).toBe("commit_push");
    expect(commit.commitCount).toBe(1);
    const pushed = buildRunTelemetry({ ...baseInput, workProducts: [{ type: "pull_request" }] });
    expect(pushed.outcomeCategory).toBe("commit_push");
    expect(pushed.pullRequestCount).toBe(1);

    expect(buildRunTelemetry({ ...baseInput, commentCount: 1 }).outcomeCategory).toBe("comment_only");
    expect(buildRunTelemetry(baseInput).outcomeCategory).toBe("nothing");
  });

  it("does not mistake non-status issue updates for a status outcome", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      activity: [{ action: "issue.updated", details: { title: "Changed", status: "todo" } }],
    });
    expect(telemetry.outcomeCategory).toBe("nothing");
    expect(telemetry.statusChangeCount).toBe(0);
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
    await db.delete(heartbeatRuns);
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
