import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// 1.7 PRIVATE-TASKS C (OPE-12197): a private task (any status) never becomes a
// heartbeat run candidate and is never picked up by an agent. A control public
// task under the same conditions is still taken.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Private-tasks test run.",
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

describeEmbeddedPostgres("heartbeat private-task suppression (1.7 PRIVATE-TASKS C)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-private-tasks-heartbeat-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, MYRMIDON_IN_WORKTREE: "false" } });
  }, 30_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
  });

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => run.status === "queued" || run.status === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    mockAdapterExecute.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: { skipTimerWhenNoActionableWork?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "private-tasks-co",
      issuePrefix: `PT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      // Heartbeat dispatch resolves the run's responsible user from the
      // company default; without it enqueue fails with "Unable to resolve
      // responsible user for heartbeat run dispatch".
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-private",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          ...(opts.skipTimerWhenNoActionableWork ? { skipTimerWhenNoActionableWork: true } : {}),
        },
      },
      permissions: {},
      lastHeartbeatAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    return { companyId, agentId };
  }

  async function seedIssue(
    companyId: string,
    agentId: string | null,
    status: string,
    opts: { isPrivate?: boolean } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: opts.isPrivate ? "Private task" : "Public task",
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      isPrivate: opts.isPrivate ?? false,
    });
    return issueId;
  }

  async function runsOf(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  async function wakeRequests(agentId: string) {
    return db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  const timerWake = (agentId: string) =>
    heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "system", reason: "heartbeat_timer" });

  it("timer heartbeat with a private todo and a free agent creates no run; the public control task is taken", async () => {
    const { companyId, agentId } = await seedAgent();
    // Only the private todo is assigned: timer scheduler must not pick it.
    await seedIssue(companyId, agentId, "todo", { isPrivate: true });

    const firstTick = await heartbeat.tickTimers(new Date("2026-01-01T00:02:00.000Z"));
    expect(firstTick.enqueued).toBe(0);
    expect(await runsOf(agentId)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // Control: the same agent with a public todo under the same conditions
    // gets the task picked up on the next due timer tick.
    const publicId = await seedIssue(companyId, agentId, "todo");
    const secondTick = await heartbeat.tickTimers(new Date("2026-01-01T00:05:00.000Z"));
    expect(secondTick.enqueued).toBe(1);
    const runs = await runsOf(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({ issueId: publicId });
  });

  it("timer heartbeat ignores a private in_progress task when only it is assigned", async () => {
    const { companyId, agentId } = await seedAgent();
    await seedIssue(companyId, agentId, "in_progress", { isPrivate: true });

    const tick = await heartbeat.tickTimers(new Date("2026-01-01T00:02:00.000Z"));
    expect(tick.enqueued).toBe(0);
    expect(await runsOf(agentId)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("timer heartbeat picks the public task and never the private one when both are ready", async () => {
    const { companyId, agentId } = await seedAgent();
    const privateId = await seedIssue(companyId, agentId, "todo", { isPrivate: true });
    const publicId = await seedIssue(companyId, agentId, "todo");

    const tick = await heartbeat.tickTimers(new Date("2026-01-01T00:02:00.000Z"));
    expect(tick.enqueued).toBe(1);
    const runs = await runsOf(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot?.issueId).toBe(publicId);
    expect(runs[0]?.contextSnapshot?.issueId).not.toBe(privateId);
  });

  it("generic idle-skip timer wake ignores private todo, private review, and private pending interactions", async () => {
    const { companyId, agentId } = await seedAgent({ skipTimerWhenNoActionableWork: true });
    await seedIssue(companyId, agentId, "todo", { isPrivate: true });
    const privateReviewId = await seedIssue(companyId, null, "in_review", { isPrivate: true });
    await db
      .update(issues)
      .set({ executionState: { currentParticipant: { type: "agent", agentId, userId: null } } as never })
      .where(eq(issues.id, privateReviewId));
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: privateReviewId,
      kind: "request_confirmation",
      status: "pending",
      addresseeAgentId: agentId,
      payload: { version: 1, prompt: "Approve?" },
    });

    expect(await timerWake(agentId)).toBeNull();
    expect(await runsOf(agentId)).toHaveLength(0);
    expect(await wakeRequests(agentId)).toEqual([
      { status: "skipped", reason: "heartbeat.timer.no_actionable_work" },
    ]);
  });

  it("an automation wake bound to a private issue is skipped with a durable receipt and no run", async () => {
    const { companyId, agentId } = await seedAgent();
    const privateId = await seedIssue(companyId, agentId, "in_progress", { isPrivate: true });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: privateId, commentId: randomUUID() },
      contextSnapshot: { issueId: privateId, wakeReason: "issue_commented" },
    });

    expect(run).toBeNull();
    expect(await runsOf(agentId)).toHaveLength(0);
    const receipts = await wakeRequests(agentId);
    expect(receipts).toEqual([
      { status: "skipped", reason: "heartbeat.private_issue_suppressed" },
    ]);
  });

  it("an idle-pickup-style wake still admits a public task (control)", async () => {
    const { companyId, agentId } = await seedAgent();
    const publicId = await seedIssue(companyId, agentId, "todo");

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: publicId, commentId: randomUUID() },
      contextSnapshot: { issueId: publicId, wakeReason: "issue_commented" },
    });

    expect(run).not.toBeNull();
    const runs = await runsOf(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot?.issueId).toBe(publicId);
  });
});
