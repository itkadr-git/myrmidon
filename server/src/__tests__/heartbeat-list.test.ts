import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { boundHeartbeatRunEventPayloadForStorage, heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it("returns summary list rows without heavy run detail fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
        runTelemetry: { outcomeCategory: null, modelCallCount: 0 },
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary: true });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      error: "Failed after doing useful work",
      usageJson: null,
      resultJson: null,
      runTelemetry: { outcomeCategory: null, modelCallCount: 0 },
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logSha256: null,
      externalRunId: null,
      processPid: null,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
        runTelemetry: { outcomeCategory: "nothing", modelCallCount: 0, gatewayCallIds: ["gw-1"] },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      runTelemetry: { outcomeCategory: "nothing", gatewayCallIds: ["gw-1"] },
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
  });

  it("filters runs by wakeReason and hasResult, returning a subset with brief result fields", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Agent1",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Agent2",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const run1Id = randomUUID();
    const run2Id = randomUUID();
    const run3Id = randomUUID();
    const run4Id = randomUUID();
    const run5Id = randomUUID();

    // Run 1: agentId, wakeReason="issue_assigned", hasResult
    await db.insert(heartbeatRuns).values({
      id: run1Id,
      companyId,
      agentId,
      status: "succeeded",
      contextWakeReason: "issue_assigned",
      resultJson: {
        summary: "completed task successfully",
        result: "success",
        message: "finished all steps",
      },
    });

    // Run 2: agentId, wakeReason="issue_commented", hasResult
    await db.insert(heartbeatRuns).values({
      id: run2Id,
      companyId,
      agentId,
      status: "succeeded",
      contextWakeReason: "issue_commented",
      resultJson: {
        summary: "answered question",
        result: "done",
      },
    });

    // Run 3: agentId, wakeReason="issue_assigned", NO result (resultJson == null)
    await db.insert(heartbeatRuns).values({
      id: run3Id,
      companyId,
      agentId,
      status: "running",
      contextWakeReason: "issue_assigned",
      resultJson: null,
    });

    // Run 4: otherAgentId, wakeReason="issue_assigned", hasResult
    await db.insert(heartbeatRuns).values({
      id: run4Id,
      companyId,
      agentId: otherAgentId,
      status: "succeeded",
      contextWakeReason: "issue_assigned",
      resultJson: {
        summary: "other agent finished",
        result: "ok",
      },
    });

    // Run 5: agentId, legacy contextSnapshot with wakeReason="issue_assigned", contextWakeReason column null
    await db.insert(heartbeatRuns).values({
      id: run5Id,
      companyId,
      agentId,
      status: "succeeded",
      contextWakeReason: null,
      contextSnapshot: {
        wakeReason: "issue_assigned",
      },
      resultJson: {
        summary: "legacy run finished",
        result: "success",
      },
    });

    const service = heartbeatService(db);

    // 1. All runs for company
    const allCompanyRuns = await service.list(companyId);
    expect(allCompanyRuns).toHaveLength(5);

    // 2. Filter by agentId
    const agentRuns = await service.list(companyId, agentId);
    expect(agentRuns).toHaveLength(4);

    // 3. Filter by wakeReason returns a subset (including legacy contextSnapshot fallback)
    const assignedRuns = await service.list(companyId, undefined, undefined, {
      wakeReason: "issue_assigned",
    });
    expect(assignedRuns).toHaveLength(4);
    expect(assignedRuns.map((r) => r.id).sort()).toEqual([run1Id, run3Id, run4Id, run5Id].sort());

    const commentedRuns = await service.list(companyId, undefined, undefined, {
      wakeReason: "issue_commented",
    });
    expect(commentedRuns).toHaveLength(1);
    expect(commentedRuns[0]?.id).toBe(run2Id);

    // 4. Filter by hasResult=true returns only runs with resultJson != null
    const runsWithResult = await service.list(companyId, undefined, undefined, {
      hasResult: true,
    });
    expect(runsWithResult).toHaveLength(4);
    expect(runsWithResult.map((r) => r.id).sort()).toEqual([run1Id, run2Id, run4Id, run5Id].sort());

    // 5. Combined filter: agentId + wakeReason="issue_assigned" + hasResult=true
    const combinedRuns = await service.list(companyId, agentId, undefined, {
      wakeReason: "issue_assigned",
      hasResult: true,
    });
    expect(combinedRuns).toHaveLength(2);
    expect(combinedRuns.map((r) => r.id).sort()).toEqual([run1Id, run5Id].sort());
    const run1Match = combinedRuns.find((r) => r.id === run1Id);
    expect(run1Match).toMatchObject({
      contextWakeReason: "issue_assigned",
      resultSummary: "completed task successfully",
      resultResult: "success",
      resultMessage: "finished all steps",
    });

    // 6. Test listVersionKey reflects the filters
    const vkAll = await service.listVersionKey(companyId);
    const vkAssigned = await service.listVersionKey(companyId, undefined, undefined, false, undefined, "issue_assigned");
    const vkWithResult = await service.listVersionKey(companyId, undefined, undefined, false, undefined, undefined, true);
    expect(vkAssigned).not.toBe(vkAll);
    expect(vkWithResult).not.toBe(vkAll);
    expect(vkAssigned).not.toBe(vkWithResult);
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
