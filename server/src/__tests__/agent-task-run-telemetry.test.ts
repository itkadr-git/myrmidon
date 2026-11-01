import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  issueWorkProducts,
  litellmCostEvents,
  statusDecisions,
  workAssessments,
  completionContracts,
  nativeRunResults,
} from "@myrmidon/db";
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
      invocationSource: "automation" as const,
      triggerDetail: "manual" as const,
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
        payload: {
          sourceEventId: "source-event-7",
          sourceSeq: 7,
          modelCallCount: 4,
          eventRevision: "2026-10-26T16:00:00.000Z",
        },
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
      modelCallCount: 4,
      litellmRequestIds: ["gw-1", "gw-2"],
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      gatewaySpendCents: 5,
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

  it("preserves explicit gateway count and keeps ID namespaces separate", () => {
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

  it("does not infer a total call count by adding distinct ID namespaces", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      wakeup: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "issue_commented",
        payload: { gatewayCallIds: ["gw-1", "gw-2"], litellmRequestIds: ["req-1", "req-2", "req-3"] },
      },
      run: { ...baseInput.run, resultJson: null },
    });
    expect(telemetry.modelCallCount).toBeNull();
    expect(telemetry.modelCallCountSource).toBe("unknown");
  });

  it("identifies a single call-ID namespace used as a count proxy", () => {
    const gateway = buildRunTelemetry({
      ...baseInput,
      run: { ...baseInput.run, resultJson: { gatewayCallIds: ["gw-a", "gw-b"] } },
      gatewayCalls: [],
    });
    expect(gateway.modelCallCount).toBe(2);
    expect(gateway.modelCallCountSource).toBe("gateway_call_ids");

    const litellm = buildRunTelemetry({
      ...baseInput,
      gatewayCalls: [{ requestId: "req-a", costCents: 1 }],
    });
    expect(litellm.modelCallCount).toBe(1);
    expect(litellm.modelCallCountSource).toBe("litellm_request_ids");
  });

  it("prefers immutable wake revision to issue timestamp from later in the run", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      issueUpdatedAt: new Date("2026-10-26T20:00:00.000Z"),
      run: { ...baseInput.run, contextSnapshot: { issueId: "issue-1", eventRevision: "2026-10-26T16:00:00.000Z" } },
    });
    expect(telemetry.eventRevision).toBe("2026-10-26T16:00:00.000Z");
  });

  it("uses issues.updatedAt when run issue context exists and no wake revision was recorded", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      run: { ...baseInput.run, contextSnapshot: { issueId: "issue-1" } },
      issueUpdatedAt: new Date("2026-10-26T16:00:00.000Z"),
    });
    expect(telemetry.eventRevision).toBe("2026-10-26T16:00:00.000Z");
  });

  it("prefers the immutable revision carried by the wake receipt to a later issue timestamp", () => {
    const telemetry = buildRunTelemetry({
      ...baseInput,
      issueUpdatedAt: new Date("2026-10-26T18:00:00.000Z"),
      wakeup: {
        source: "on_demand",
        triggerDetail: "callback",
        reason: "issue_commented",
        payload: { eventRevision: "2026-10-26T16:00:00.000Z" },
      },
    });
    expect(telemetry.eventRevision).toBe("2026-10-26T16:00:00.000Z");
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

    const branch = buildRunTelemetry({ ...baseInput, workProducts: [{ type: "branch" }] });
    expect(branch.outcomeCategory).toBe("commit_push");
    expect(branch.branchCount).toBe(1);

    expect(buildRunTelemetry(baseInput).outcomeCategory).toBeNull();
    expect(buildRunTelemetry({ ...baseInput, workProducts: [{ type: "status" }] }).outcomeCategory).toBe("other_work_product");
    expect(buildRunTelemetry({ ...baseInput, workProducts: [{ type: "comment" }] }).outcomeCategory).toBe("other_work_product");
    expect(buildRunTelemetry({ ...baseInput, workProducts: [{ type: "no_change" }] }).outcomeCategory).toBe("other_work_product");
    expect(buildRunTelemetry({ ...baseInput, outcomeCategoryOverride: "status" }).outcomeCategory).toBe("status");
    expect(buildRunTelemetry({ ...baseInput, outcomeCategoryOverride: "comment_only" }).outcomeCategory).toBe("comment_only");
    expect(buildRunTelemetry({ ...baseInput, outcomeCategoryOverride: "nothing" }).outcomeCategory).toBe("nothing");
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
    await db.delete(issueWorkProducts);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(litellmCostEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
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
      status: "completed",
      runId,
      payload: {
        issueId,
        sourceEventId: "comment-12",
        sourceSeq: 12,
        eventRevision: issueUpdatedAt.toISOString(),
      },
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
      resultJson: { gatewayCallIds: ["gateway-call-12"], modelCallCount: 2 },
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
      modelCallCount: 2,
      modelCallCountSource: "gateway_count",
      gatewaySpendCents: 7,
      apiEquivalentCostUsd: 0.000025,
      outcomeCategory: "nothing",
    });
  });

  it("records the status, comment-only, and no-change outcomes from persisted issue activity", async () => {
    await seedCompanyAndAgent();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "manual",
      status: "succeeded",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "telemetry outcome test", status: "todo" });
    const contractId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
      risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "test",
    });
    await db.update(heartbeatRuns).set({
      nativeIssueId: issueId,
      completionContractId: contractId,
    }).where(eq(heartbeatRuns.id, runId));
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    const resultId = randomUUID();
    await db.insert(nativeRunResults).values({
      id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "valid", resultJson: {},
      canonicalSha256: randomUUID(),
    });
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({
      id: assessmentId, companyId, issueId, runId, contractId, resultId,
      triggerKind: "test", triggerActorCompanyId: companyId,
      priorIssueStatus: "todo", priorStatusVersion: 0,
      policyVersion: "test", assessmentJson: {}, inputDigest: randomUUID(),
    });
    await db.insert(statusDecisions).values({
      id: randomUUID(), companyId, issueId, runId, assessmentId,
      decisionVersion: 1, policyVersion: "test", fromStatus: "todo", toStatus: "in_progress",
      reasonCode: "test", decisionJson: {}, decisionDigest: randomUUID(),
      applicationState: "applied", createdAt: new Date(),
    });
    await emitAgentTaskRun(db, run);
    const [statusResult] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((statusResult.resultJson as any).runTelemetry.outcomeCategory).toBe("status");

    await db.delete(statusDecisions).where(eq(statusDecisions.issueId, issueId));
    await db.insert(issueComments).values({ id: randomUUID(), companyId, issueId, createdByRunId: runId, body: "comment only" });
    await emitAgentTaskRun(db, run);
    const [commentResult] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((commentResult.resultJson as any).runTelemetry.outcomeCategory).toBe("comment_only");

    await db.delete(issueComments).where(eq(issueComments.createdByRunId, runId));
    // Ordinary completed terminal run without issue activity yields "nothing"
    await emitAgentTaskRun(db, run);
    const [emptyResult] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect((emptyResult.resultJson as any).runTelemetry.outcomeCategory).toBe("nothing");

    // A pending/running run without terminal status or completion timestamps yields null
    const pendingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: pendingRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      contextSnapshot: { issueId },
    });
    const pendingRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, pendingRunId)).then((r) => r[0]!);
    await emitAgentTaskRun(db, pendingRun);
    const [pendingResult] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, pendingRunId));
    expect((pendingResult.resultJson as any).runTelemetry.outcomeCategory).toBeNull();
  });

  it("separately attributes commit and push work products and persists aggregation fields into runTelemetry", async () => {
    await seedCompanyAndAgent();
    const runId = randomUUID();
    const issueId = randomUUID();
    const startedAt = new Date(Date.now() - 6000);
    const finishedAt = new Date();
    await db.insert(issues).values({ id: issueId, companyId, title: "telemetry work products test", status: "todo" });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "manual",
      status: "succeeded",
      startedAt,
      finishedAt,
      contextSnapshot: { issueId },
    });

    await db.insert(issueWorkProducts).values([
      {
        id: randomUUID(),
        companyId,
        issueId,
        createdByRunId: runId,
        type: "commit",
        provider: "git",
        status: "created",
        title: "commit: feat(telemetry)",
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        createdByRunId: runId,
        type: "pull_request",
        provider: "github",
        status: "open",
        title: "PR #1888",
      },
      {
        id: randomUUID(),
        companyId,
        issueId,
        createdByRunId: runId,
        type: "branch",
        provider: "git",
        status: "active",
        title: "bot/OPE-9499",
      },
    ]);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    await emitAgentTaskRun(db, run);

    const [saved] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const telemetry = (saved.resultJson as any)?.runTelemetry;
    expect(telemetry).toBeDefined();
    expect(telemetry.outcomeCategory).toBe("commit_push");
    expect(telemetry.commitCount).toBe(1);
    expect(telemetry.pullRequestCount).toBe(1);
    expect(telemetry.branchCount).toBe(1);
    expect(telemetry.artifactCount).toBe(0);
    expect(telemetry.documentCount).toBe(0);
    expect(telemetry.otherWorkProductCount).toBe(0);

    // Verify fields are available for aggregation
    expect(telemetry.runId).toBe(runId);
    expect(telemetry.agentId).toBe(agentId);
    expect(telemetry.issueId).toBe(issueId);
    expect(telemetry.apiEquivalentCostStatus).toBe("not_applicable");
    expect(telemetry.gatewaySpendCents).toBe(0);
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
