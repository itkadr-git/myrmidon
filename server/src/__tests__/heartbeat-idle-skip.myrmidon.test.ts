import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  activityLog,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// M3: an idle agent's generic timer heartbeat does not start a model run.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Idle-skip test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("skip idle timer heartbeats (M3)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previous = process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-myrmidon-idle-skip-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    if (previous === undefined) delete process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS;
    else process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = previous;
    // Each test seeds its own company and agent; let dispatched runs settle.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string | null, status: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
    });
    return issueId;
  }

  async function expectCheckoutContext(contextSnapshot: unknown, companyId: string, agentId: string) {
    const runId = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)))[0]!.id;
    const { assertRunHasTaskSourceContext } = await import("../myrmidon/issue-checkout-guard.ts");
    await expect(assertRunHasTaskSourceContext(db, { companyId, agentId, runId })).resolves.toBe(
      (contextSnapshot as { issueId: string }).issueId,
    );
    const unscopedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unscopedRunId, companyId, agentId, invocationSource: "timer", status: "running", contextSnapshot: {},
    });
    await expect(assertRunHasTaskSourceContext(db, { companyId, agentId, runId: unscopedRunId }))
      .rejects.toMatchObject({ status: 403, details: { code: "cross_issue_influence_run_context_required" } });
  }

  const timerWake = (agentId: string) =>
    heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system", reason: "heartbeat_timer" });

  async function wakeRequests(agentId: string) {
    return db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("skips the timer wake of an agent with no work: no run, wake skipped as no_actionable_work", async () => {
    process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = "true";
    const { agentId } = await seedAgent();

    expect(await timerWake(agentId)).toBeNull();

    expect(await wakeRequests(agentId)).toEqual([
      { status: "skipped", reason: "heartbeat.timer.no_actionable_work" },
    ]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.agentId, agentId)))
      .toContainEqual({ action: "heartbeat.timer.no_actionable_work" });
  });

  it("timer scheduler binds its wake to the ready assigned issue", async () => {
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue(companyId, agentId, "todo");
    await db.update(agents).set({ lastHeartbeatAt: new Date("2000-01-01T00:00:00Z") }).where(eq(agents.id, agentId));

    await heartbeat.tickTimers(new Date());

    const run = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).limit(1);
    expect(run[0]?.contextSnapshot).toMatchObject({ issueId, wakeReason: "heartbeat_timer" });
    await expectCheckoutContext(run[0]!.contextSnapshot, companyId, agentId);
  });

  it("does not schedule a timer wake when the agent's only assigned task is blocked", async () => {
    const { companyId, agentId } = await seedAgent();
    const blockedId = await seedIssue(companyId, agentId, "todo");
    const blockerId = await seedIssue(companyId, null, "in_progress");
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: blockedId, type: "blocks" });
    await db.update(agents).set({ lastHeartbeatAt: new Date("2000-01-01T00:00:00Z") }).where(eq(agents.id, agentId));

    await heartbeat.tickTimers(new Date());

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(await wakeRequests(agentId)).toHaveLength(0);
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.agentId, agentId)))
      .toContainEqual({ action: "heartbeat.timer.no_actionable_work" });
  });

  it("does not schedule a duplicate timer wake when the assigned task already has a live run", async () => {
    const { companyId, agentId } = await seedAgent();
    const liveId = await seedIssue(companyId, agentId, "in_progress");
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "on_demand", status: "running",
      contextSnapshot: { issueId: liveId },
    });
    await db.update(agents).set({ lastHeartbeatAt: new Date("2000-01-01T00:00:00Z") }).where(eq(agents.id, agentId));

    await heartbeat.tickTimers(new Date());

    const runs = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({ issueId: liveId });
    expect(await wakeRequests(agentId)).toHaveLength(0);
  });

  it("does not inspect timer work or log no-actionable-work before the timer is due", async () => {
    const { agentId } = await seedAgent();
    const baseline = new Date("2026-01-01T00:00:00.000Z");
    await db.update(agents).set({ lastHeartbeatAt: baseline }).where(eq(agents.id, agentId));

    await heartbeat.tickTimers(new Date(baseline.getTime() + 500));

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(await wakeRequests(agentId)).toHaveLength(0);
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.agentId, agentId)))
      .not.toContainEqual({ action: "heartbeat.timer.no_actionable_work" });
  });

  it("does not schedule a timer wake when the agent has no ready task", async () => {
    const { agentId } = await seedAgent();
    await db.update(agents).set({ lastHeartbeatAt: new Date("2000-01-01T00:00:00Z") }).where(eq(agents.id, agentId));

    await heartbeat.tickTimers(new Date());

    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId))).toHaveLength(0);
    expect(await wakeRequests(agentId)).toHaveLength(0);
    expect(await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.agentId, agentId)))
      .toContainEqual({ action: "heartbeat.timer.no_actionable_work" });
  });

  it("runs when the agent has a todo issue", async () => {
    process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = "true";
    const { companyId, agentId } = await seedAgent();
    await seedIssue(companyId, agentId, "todo");

    expect(await timerWake(agentId)).not.toBeNull();
  });

  it("runs when a pending interaction is addressed to the agent", async () => {
    process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = "true";
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue(companyId, null, "in_progress");
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      addresseeAgentId: agentId,
      payload: { version: 1, prompt: "Approve?" },
    });

    expect(await timerWake(agentId)).not.toBeNull();
  });

  it("runs when the agent is the current reviewer of an in_review issue", async () => {
    process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = "true";
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue(companyId, null, "in_review");
    await db
      .update(issues)
      .set({ executionState: { currentParticipant: { type: "agent", agentId, userId: null } } as never })
      .where(eq(issues.id, issueId));

    expect(await timerWake(agentId)).not.toBeNull();
  });

  it("always runs a comment wake, even for an agent with no other work", async () => {
    process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS = "true";
    const { companyId, agentId } = await seedAgent();
    const issueId = await seedIssue(companyId, null, "in_progress");

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: { issueId, wakeReason: "issue_commented", commentId: randomUUID() },
    });

    expect(run).not.toBeNull();
  });

  it("keeps the vendor behaviour when the setting is off", async () => {
    delete process.env.MYRMIDON_SKIP_IDLE_HEARTBEATS;
    const { agentId } = await seedAgent();

    expect(await timerWake(agentId)).not.toBeNull();
    expect((await wakeRequests(agentId)).map((row) => row.status)).not.toContain("skipped");
  });
});
