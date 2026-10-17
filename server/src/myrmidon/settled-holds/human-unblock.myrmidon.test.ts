// myrmidon(HOLD-READY): a board operator unblocking an issue lifts its
// settled "do not replay" hold and the agent is woken — end to end through
// the real PATCH /issues/:id, the real wake admission (heartbeat.ts) and the
// manual-wake route. See human-unblock.ts.
//
// The seeded state is the one that stalled a team: a closed recovery action
// with `evidence.automaticRecovery.replay = "blocked"` and a comment wake the
// admission parked on it (`deferred_issue_execution` + `executionWait`). The
// status-change and comment wakes of a board PATCH are not explicit wakes, so
// before the fix they were parked as well and nothing ever started.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
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
    summary: "Human-unblock test run.",
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
import { agentRoutes } from "../../routes/agents.js";
import { issueRoutes } from "../../routes/issues.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { isHumanUnblock, mayBeHumanUnblock } from "./human-unblock.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const RUN_WAIT_MS = 60_000;
const TEST_TIMEOUT_MS = 150_000;

describe("isHumanUnblock / mayBeHumanUnblock", () => {
  const board = { requestActorType: "board", runId: null };
  const side = (status: string, assigneeAgentId: string | null = "agent-a", assigneeUserId: string | null = null) => ({
    status,
    assigneeAgentId,
    assigneeUserId,
  });

  it("a board person moving the issue out of blocked into a workable status is an unblock", () => {
    expect(isHumanUnblock({ ...board, before: side("blocked"), after: side("todo") })).toBe(true);
    expect(isHumanUnblock({ ...board, before: side("blocked"), after: side("in_progress") })).toBe(true);
  });

  it("a board person reassigning a workable issue to another agent is an unblock", () => {
    expect(isHumanUnblock({ ...board, before: side("todo"), after: side("todo", "agent-b") })).toBe(true);
  });

  it("nothing else is: staying blocked, closing, handing to a user, no change", () => {
    expect(isHumanUnblock({ ...board, before: side("blocked"), after: side("blocked", "agent-b") })).toBe(false);
    expect(isHumanUnblock({ ...board, before: side("blocked"), after: side("done") })).toBe(false);
    expect(isHumanUnblock({ ...board, before: side("blocked"), after: side("todo", null, "user-a") })).toBe(false);
    expect(isHumanUnblock({ ...board, before: side("todo"), after: side("todo") })).toBe(false);
  });

  // myrmidon(OPE-6954): REQUEUE-HOLD leaves a re-queued task in its own
  // `todo`/`backlog`, so the person's "carry on" is a move into a workable
  // status from wherever the task sits, not only out of `blocked`.
  it("a board person starting a held task that already sits in a workable status is an unblock", () => {
    expect(isHumanUnblock({ ...board, before: side("todo"), after: side("in_progress") })).toBe(true);
    expect(isHumanUnblock({ ...board, before: side("backlog"), after: side("todo") })).toBe(true);
    expect(isHumanUnblock({ ...board, before: side("in_review"), after: side("in_progress") })).toBe(true);
    // Closing it, or handing it to a user, still is not.
    expect(isHumanUnblock({ ...board, before: side("todo"), after: side("done") })).toBe(false);
    expect(isHumanUnblock({ ...board, before: side("todo"), after: side("in_progress", null, "user-a") })).toBe(false);
    expect(
      mayBeHumanUnblock({ ...board, existingStatus: "todo", assigneeChangeRequested: false, statusChangeRequested: true }),
    ).toBe(true);
    expect(
      mayBeHumanUnblock({ ...board, existingStatus: "todo", assigneeChangeRequested: false, statusChangeRequested: false }),
    ).toBe(false);
    expect(
      mayBeHumanUnblock({
        requestActorType: "board",
        runId: "run-a",
        existingStatus: "todo",
        assigneeChangeRequested: false,
        statusChangeRequested: true,
      }),
    ).toBe(false);
  });

  it("an agent, or an agent's run acting through the board, is never a person unblocking", () => {
    const transition = { before: side("blocked"), after: side("todo") };
    expect(isHumanUnblock({ requestActorType: "agent", runId: null, ...transition })).toBe(false);
    expect(isHumanUnblock({ requestActorType: "board", runId: "run-a", ...transition })).toBe(false);
    expect(mayBeHumanUnblock({ requestActorType: "agent", runId: null, existingStatus: "blocked", assigneeChangeRequested: false })).toBe(false);
    expect(mayBeHumanUnblock({ requestActorType: "board", runId: "run-a", existingStatus: "blocked", assigneeChangeRequested: false })).toBe(false);
    expect(mayBeHumanUnblock({ ...board, existingStatus: "todo", assigneeChangeRequested: false })).toBe(false);
    expect(mayBeHumanUnblock({ ...board, existingStatus: "blocked", assigneeChangeRequested: false })).toBe(true);
    expect(mayBeHumanUnblock({ ...board, existingStatus: "todo", assigneeChangeRequested: true })).toBe(true);
  });
});

describeEmbeddedPostgres("a board unblock lifts a settled replay hold (HOLD-READY)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-human-unblock-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 60_000);

  afterEach(async () => {
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((run) => ["queued", "running", "scheduled_retry"].includes(run.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    mockAdapterExecute.mockClear();
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(companyId: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-a",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use("/api", agentRoutes(db));
    server.use(errorHandler);
    return server;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  /** The stuck state: todo task, settled replay hold, a comment wake parked on it. */
  async function seedStuck() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "user-a",
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await seedAgent(companyId, "agent-a");
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "task", status: "todo", priority: "high", assigneeAgentId: agentId })
      .returning();
    const issueId = issue!.id;
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId: issueId,
        kind: "active_run_watchdog",
        status: "resolved",
        cause: "uncertain_provider_action",
        fingerprint: randomUUID(),
        evidence: { automaticRecovery: { replay: "blocked" } },
        nextAction: "Preserve recorded work without replay.",
      })
      .returning();

    // A comment wake that is not explicit: the real admission parks it on the hold.
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "note from agent-a",
    });
    const parkedRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      requestedByActorType: "agent",
      requestedByActorId: agentId,
      payload: { issueId, commentId },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", commentId },
    });
    expect(parkedRun).toBeNull();
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(parked?.status).toBe("deferred_issue_execution");
    expect(parked?.payload?.executionWait).toMatchObject({ recoveryActionId: action!.id });
    return { companyId, agentId, issueId, actionId: action!.id, parkedWakeId: parked!.id };
  }

  async function replayOf(actionId: string) {
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
    return (action!.evidence.automaticRecovery ?? {}) as Record<string, unknown>;
  }

  async function runsFor(companyId: string, agentId: string, issueId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      );
  }

  async function waitForRun(companyId: string, agentId: string, issueId: string) {
    const deadline = Date.now() + RUN_WAIT_MS;
    while (Date.now() < deadline) {
      const runs = await runsFor(companyId, agentId, issueId);
      if (runs.length > 0) return runs;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return runsFor(companyId, agentId, issueId);
  }

  async function wakeStatus(wakeId: string) {
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId));
    return wake!.status;
  }

  async function waitForWakeToLeave(wakeId: string, status: string) {
    const deadline = Date.now() + RUN_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await wakeStatus(wakeId)) !== status) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return wakeStatus(wakeId);
  }

  it("reproduces the stall, then a board PATCH blocked -> todo clears the hold and the agent is woken", async () => {
    const { companyId, agentId, issueId, actionId, parkedWakeId } = await seedStuck();
    const server = app(companyId);

    // The stall: the manual wake finds no ready task (409) while the hold stands.
    const refused = await request(server).post(`/api/agents/${agentId}/wakeup`).send({});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details?.code).toBe("wakeup_requires_ready_task");

    // The operator had blocked it and now unblocks it.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    const patched = await request(server).patch(`/api/issues/${issueId}`).send({ status: "todo" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    // The hold is cleared as an operator resolve, in the PATCH's transaction.
    expect(await replayOf(actionId)).toMatchObject({
      replay: "cleared",
      replayClearedBy: "user-a",
      replayClearedByType: "user",
    });

    // The agent is woken for the task (before the fix: no run, the status
    // wake was rejected as `execution_reconciliation_required`).
    const runs = await waitForRun(companyId, agentId, issueId);
    expect(runs.length, JSON.stringify(runs)).toBeGreaterThan(0);
    expect(runs.filter((run) => run.errorCode === "execution_reconciliation_required")).toEqual([]);

    // The wake parked on the hold is re-planned, not left parked.
    expect(await waitForWakeToLeave(parkedWakeId, "deferred_issue_execution")).not.toBe("deferred_issue_execution");
  }, TEST_TIMEOUT_MS);

  it("a board reassignment of the held task clears the hold and wakes the new assignee", async () => {
    const { companyId, issueId, actionId } = await seedStuck();
    const otherAgentId = await seedAgent(companyId, "agent-b");
    const server = app(companyId);

    const patched = await request(server).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: otherAgentId });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    expect(await replayOf(actionId)).toMatchObject({ replay: "cleared", replayClearedByType: "user" });
    const runs = await waitForRun(companyId, otherAgentId, issueId);
    expect(runs.length, JSON.stringify(runs)).toBeGreaterThan(0);
    expect(runs.filter((run) => run.errorCode === "execution_reconciliation_required")).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // myrmidon(OPE-6954): the state REQUEUE-HOLD leaves behind — the actor's
  // `todo` with the settled hold — is released by the person moving the task
  // into work, since the `blocked -> todo` move the hold used to key on is
  // exactly what the closure no longer performs.
  it("a board person starting a held todo task lifts the hold and the agent is woken", async () => {
    const { companyId, agentId, issueId, actionId, parkedWakeId } = await seedStuck();
    const server = app(companyId);

    // The stall: with the hold standing the task is not ready, so the manual
    // wake is refused and the actor's re-queued task sits idle.
    const refused = await request(server).post(`/api/agents/${agentId}/wakeup`).send({});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details?.code).toBe("wakeup_requires_ready_task");

    const patched = await request(server).patch(`/api/issues/${issueId}`).send({ status: "in_progress" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    expect(await replayOf(actionId)).toMatchObject({
      replay: "cleared",
      replayClearedBy: "user-a",
      replayClearedByType: "user",
    });

    const runs = await waitForRun(companyId, agentId, issueId);
    expect(runs.length, JSON.stringify(runs)).toBeGreaterThan(0);
    expect(runs.filter((run) => run.errorCode === "execution_reconciliation_required")).toEqual([]);
    expect(await waitForWakeToLeave(parkedWakeId, "deferred_issue_execution")).not.toBe("deferred_issue_execution");
  }, TEST_TIMEOUT_MS);

  it("without a human unblock the held task stays held and is not reported as ready", async () => {
    const { companyId, agentId, issueId, actionId, parkedWakeId } = await seedStuck();
    const server = app(companyId);

    // A board edit that is not an unblock leaves the hold alone.
    const patched = await request(server).patch(`/api/issues/${issueId}`).send({ title: "task, renamed" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await replayOf(actionId)).toMatchObject({ replay: "blocked" });

    const refused = await request(server).post(`/api/agents/${agentId}/wakeup`).send({});
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.details?.code).toBe("wakeup_requires_ready_task");
    expect(await runsFor(companyId, agentId, issueId)).toEqual([]);
    expect(await wakeStatus(parkedWakeId)).toBe("deferred_issue_execution");
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, TEST_TIMEOUT_MS);
});
