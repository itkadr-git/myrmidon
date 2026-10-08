// myrmidon(OPE-6011): a person's comment that @-mentions the task's assignee
// is an explicit wake past a settled execution-reconciliation hold, and an
// agent's comment is not — the full failed-run → hold → confirm → wake cycle
// the ticket asks for, run through the real admission (heartbeat.ts's
// enqueueWakeup) and claim (run-dispatch/adapters/postgres.ts).
//
// Scenarios covered:
//  - a user's comment that @-mentions the woken agent starts a run (the hold
//    is superseded in the admission transaction);
//  - an agent's comment, even one that mentions the agent, stays deferred;
//  - a user's comment that does not mention the woken agent stays deferred;
//  - POST /issues/:id/execution-hold/confirm-continue supersedes the hold and
//    wakes the assignee — the card's Confirm verb end to end.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Execution-hold mention-wake test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/index.ts")>("../../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { errorHandler } from "../../middleware/index.js";
import { issueRoutes } from "../../routes/issues.js";
import { heartbeatService } from "../../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The first run in a fresh test process loads most of the server lazily and can
// take well over ten seconds on a loaded CI worker, so waits are generous and
// only ever cost time when something is actually wrong.
const RUN_WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

describeEmbeddedPostgres("execution hold: mention wake and confirm-continue (OPE-6011)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-execution-hold-mention-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId, name: "agent-a", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [issue] = await db.insert(issues).values({
      companyId, title: "task", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    // The settled ("do not replay") hold a failed run leaves behind, as on
    // OPE-5851: resolved with outcome blocked and replay blocked.
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issue!.id, kind: "execution_reconciliation",
      status: "resolved", cause: "uncertain_provider_action", fingerprint: randomUUID(),
      evidence: { automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } },
      nextAction: "Automatic recovery stopped.",
    }).returning();
    return { companyId, agentId, issueId: issue!.id, actionId: action!.id };
  }

  async function holdOf(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return action!;
  }

  async function waitForRunToFinish(runId: string, timeoutMs = RUN_WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running", "scheduled_retry"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId);
  }

  async function userCommentWake(
    companyId: string, agentId: string, issueId: string,
    body: string,
    author: { authorType: "user" | "agent"; authorUserId?: string | null; authorAgentId?: string | null } = { authorType: "user", authorUserId: "user-a" },
  ) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId,
      authorUserId: author.authorUserId ?? null,
      authorAgentId: author.authorAgentId ?? null,
      authorType: author.authorType,
      body,
    });
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: author.authorType,
      requestedByActorId: author.authorUserId ?? author.authorAgentId ?? null,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", commentId },
    });
  }

  function confirmApp(companyId: string, actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use("/api", issueRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const boardActor = (companyId: string) => ({
    type: "board", userId: "user-a", companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: true, source: "local_implicit",
  });

  it("a user's comment that @-mentions the assignee starts a run and supersedes the hold", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const run = await userCommentWake(companyId, agentId, issueId, `Please continue [@agent-a](agent://${agentId})`);
    expect(run).not.toBeNull();
    const superseded = await holdOf(actionId);
    const recovery = superseded.evidence.automaticRecovery as Record<string, unknown>;
    expect(recovery.replay).toBe("explicit_wake_superseded");
    const finished = await waitForRunToFinish(run!.id);
    expect(finished?.status).not.toBe("cancelled");
    expect(finished?.errorCode).not.toBe("execution_reconciliation_required");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  it("an agent's comment, even one that mentions the agent, stays deferred", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const result = await userCommentWake(
      companyId, agentId, issueId,
      `Please continue [@agent-a](agent://${agentId})`,
      { authorType: "agent", authorAgentId: agentId },
    );
    expect(result).toBeNull();
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(deferred?.status).toBe("deferred_issue_execution");
    const hold = await holdOf(actionId);
    expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("blocked");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it("a user's comment that does not mention the assignee stays deferred", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const result = await userCommentWake(companyId, agentId, issueId, "Any update on this?");
    expect(result).toBeNull();
    const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(deferred?.status).toBe("deferred_issue_execution");
    const hold = await holdOf(actionId);
    expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("blocked");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);

  it("POST /issues/:id/execution-hold/confirm-continue supersedes the hold and wakes the assignee", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const res = await request(confirmApp(companyId, boardActor(companyId)))
      .post(`/api/issues/${issueId}/execution-hold/confirm-continue`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ issueId, recoveryActionId: actionId, assigneeWoken: true });
    expect(res.body.supersededCount).toBeGreaterThan(0);
    const hold = await holdOf(actionId);
    expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("explicit_wake_superseded");
    // The wake created a run that is not held.
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.length).toBeGreaterThan(0);
    const finished = await waitForRunToFinish(runs[0]!.id);
    expect(finished?.errorCode).not.toBe("execution_reconciliation_required");
  }, TEST_TIMEOUT_MS);

  it("POST /issues/:id/execution-hold/confirm-continue is a 404 once the hold is gone", async () => {
    const { companyId, agentId, issueId } = await seed();
    const app = confirmApp(companyId, boardActor(companyId));
    const first = await request(app).post(`/api/issues/${issueId}/execution-hold/confirm-continue`).send({});
    expect(first.status).toBe(200);
    await waitForRunToFinish((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))[0]!.id);
    const second = await request(app).post(`/api/issues/${issueId}/execution-hold/confirm-continue`).send({});
    expect(second.status).toBe(404);
  }, TEST_TIMEOUT_MS);

  it("an agent that is not the assignee cannot confirm the hold", async () => {
    const { companyId, agentId, issueId, actionId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "agent-b", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const res = await request(confirmApp(companyId, {
      type: "agent", agentId: otherAgentId, companyId, source: "agent_key", runId: randomUUID(),
    }))
      .post(`/api/issues/${issueId}/execution-hold/confirm-continue`)
      .send({});
    expect(res.status).toBe(403);
    const hold = await holdOf(actionId);
    expect((hold.evidence.automaticRecovery as Record<string, unknown>).replay).toBe("blocked");
  }, TEST_TIMEOUT_MS);
});
