// myrmidon(BLOCKED-LOOP): route-level test of the repeated-return limiter.
// An agent that keeps returning a task to `blocked` with the same blocker set
// and the same unblock descriptor is stopped after N returns with 422.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-loop route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Only dispatch is replaced: entering blocked with an agent owner wakes that
// agent, and this fixture must not launch a real run.
vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async () => null,
    }),
  };
});

const MAX_RETURNS_ENV = "MYRMIDON_BLOCKED_LOOP_MAX_RETURNS";

describeEmbeddedPostgres("blocked loop limiter (route level)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-blocked-loop-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    delete process.env[MAX_RETURNS_ENV];
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWatchdogs);
    await db.delete(agentTaskSessions);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const doneBlockerId = randomUUID();
    const otherBlockerId = randomUUID();
    const issueId = randomUUID();

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
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values([
      {
        id: doneBlockerId,
        companyId,
        title: "Done blocker",
        status: "done",
        priority: "medium",
        completedAt: new Date(),
      },
      {
        id: otherBlockerId,
        companyId,
        title: "Another open blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: issueId,
        companyId,
        title: "Looping task",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
        checkoutRunId: runId,
        executionRunId: runId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      },
    ]);
    return { companyId, agentId, runId, issueId, doneBlockerId, otherBlockerId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  function agentActor(s: Seeded): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: s.agentId,
      companyId: s.companyId,
      runId: s.runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: true,
      source: "session",
    };
  }

  function descriptorFor(s: Seeded, action = "Waiting for the external check") {
    return {
      owner: { agentId: s.agentId },
      action,
      reasonRef: { kind: "issue", issueId: s.doneBlockerId },
    };
  }

  /** Puts the task back to work, as an unblock followed by the agent picking it up would. */
  async function backToWork(s: Seeded) {
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: s.runId,
        executionRunId: s.runId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, s.issueId));
  }

  async function agentBlocks(s: Seeded, body: Record<string, unknown>) {
    await backToWork(s);
    return request(createApp(agentActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({
        status: "blocked",
        blockerMetadata: {
          blockReason: "dependency",
          owner: { agentId: s.agentId },
          externalRef: "blocked-loop-test",
          nextCheckAt: "2026-10-20T00:00:00.000Z",
          timeoutAt: "2026-10-21T00:00:00.000Z",
          escalationPolicy: "agent",
        },
        unblockDescriptor: descriptorFor(s),
        ...body,
      });
  }

  it("rejects an agent-authored blocked transition without blocker metadata", async () => {
    const s = await seed();
    await backToWork(s);
    const res = await request(createApp(agentActor(s)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "blocked", unblockDescriptor: descriptorFor(s) });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("blockerMetadata");
    expect(res.body.missingFields).toEqual([
      "blockReason",
      "owner",
      "nextCheckAt",
      "timeoutAt",
      "escalationPolicy",
      "blockedByIssueIds or externalRef",
    ]);
  });

  it("rejects blocked edges without typed metadata and lists the missing fields", async () => {
    const s = await seed();
    await db.insert(issueRelations).values({
      companyId: s.companyId,
      issueId: s.issueId,
      relatedIssueId: s.doneBlockerId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [s.doneBlockerId] });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.missingFields).toEqual([
      "blockReason",
      "owner",
      "nextCheckAt",
      "timeoutAt",
      "escalationPolicy",
      "blockedByIssueIds or externalRef",
    ]);
  });

  it("does not require new blocker metadata when editing a legacy blocked issue", async () => {
    const s = await seed();
    await db.update(issues).set({ status: "blocked", blockerMetadata: null }).where(eq(issues.id, s.issueId));

    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ description: "Unrelated legacy edit" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("blocked");
    const stored = await db
      .select({ blockerMetadata: issues.blockerMetadata })
      .from(issues)
      .where(eq(issues.id, s.issueId))
      .then((rows) => rows[0]?.blockerMetadata);
    expect(stored).toBeNull();
  });

  it("accepts an agent-authored blocked transition with blocker metadata", async () => {
    const s = await seed();
    const res = await agentBlocks(s, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("blocked");
  });

  it("rejects an external_wait block without executionPolicy.monitor", async () => {
    const s = await seed();
    const res = await agentBlocks(s, {
      blockerMetadata: {
        blockReason: "external_wait",
        owner: { agentId: s.agentId },
        externalRef: "ci-run-1",
        nextCheckAt: "2026-10-20T00:00:00.000Z",
        timeoutAt: "2026-10-21T00:00:00.000Z",
        escalationPolicy: "agent",
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("external_wait requires executionPolicy.monitor");
  });

  it("clears blocker metadata when the task leaves blocked", async () => {
    const s = await seed();
    const blocked = await agentBlocks(s, {});
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    const stored = await db
      .select({ blockerMetadata: issues.blockerMetadata })
      .from(issues)
      .where(eq(issues.id, s.issueId))
      .then((rows) => rows[0]?.blockerMetadata);
    expect(stored?.blockReason).toBe("dependency");

    const unblocked = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({ status: "todo" });
    expect(unblocked.status, JSON.stringify(unblocked.body)).toBe(200);
    const cleared = await db
      .select({ blockerMetadata: issues.blockerMetadata })
      .from(issues)
      .where(eq(issues.id, s.issueId))
      .then((rows) => rows[0]?.blockerMetadata);
    expect(cleared).toBeNull();
  });

  async function countActivity(s: Seeded, action: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, s.issueId), eq(activityLog.action, action)));
    return rows.length;
  }

  async function statusOf(s: Seeded) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, s.issueId))
      .then((rows) => rows[0]?.status);
  }

  async function returnTimes(s: Seeded, times: number, body: Record<string, unknown>) {
    for (let i = 0; i < times; i += 1) {
      const res = await agentBlocks(s, body);
      expect(res.status, `return ${i + 1}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  }

  it("lets an agent return a task to blocked 3 times and rejects the 4th with 422", async () => {
    const s = await seed();
    const body = { unblockDescriptor: descriptorFor(s) };

    await returnTimes(s, 3, body);

    const rejected = await agentBlocks(s, body);
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(rejected.body.code).toBe("blocked_loop_limit");
    expect(rejected.body.error).toContain("3 consecutive returns to blocked");
    expect(rejected.body.error).toContain("executionPolicy.monitor.nextCheckAt");
    expect(rejected.body.error).toContain("unblockDescriptor.reasonRef");

    expect(await statusOf(s)).toBe("in_progress");
    expect(await countActivity(s, "myrmidon.blocked_loop.rejected")).toBe(1);

    const rejection = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, s.issueId), eq(activityLog.action, "myrmidon.blocked_loop.rejected")))
      .then((rows) => rows[0]);
    expect(rejection.details).toMatchObject({ streak: 3, maxReturns: 3 });
  });

  it("does not write issue.updated for the rejected attempt", async () => {
    const s = await seed();
    const body = { unblockDescriptor: descriptorFor(s) };
    await returnTimes(s, 3, body);
    const before = await countActivity(s, "issue.updated");

    const rejected = await agentBlocks(s, body);
    expect(rejected.status).toBe(422);

    expect(await countActivity(s, "issue.updated")).toBe(before);
  });

  it("honours MYRMIDON_BLOCKED_LOOP_MAX_RETURNS", async () => {
    const s = await seed();
    process.env[MAX_RETURNS_ENV] = "1";
    const body = { unblockDescriptor: descriptorFor(s) };

    await returnTimes(s, 1, body);
    const rejected = await agentBlocks(s, body);

    expect(rejected.status, JSON.stringify(rejected.body)).toBe(422);
    expect(rejected.body.code).toBe("blocked_loop_limit");
  });

  it("does not limit a board actor", async () => {
    const s = await seed();
    const body = {
      blockerMetadata: {
        blockReason: "dependency",
        owner: { agentId: s.agentId },
        blockedByIssueIds: [s.doneBlockerId],
        nextCheckAt: "2026-10-20T00:00:00.000Z",
        timeoutAt: "2026-10-21T00:00:00.000Z",
        escalationPolicy: "agent",
      },
      blockedByIssueIds: [s.doneBlockerId],
      unblockDescriptor: descriptorFor(s),
    };
    await returnTimes(s, 3, body);
    expect((await agentBlocks(s, body)).status).toBe(422);

    await backToWork(s);
    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({
        status: "blocked",
        blockerMetadata: {
          blockReason: "dependency",
          owner: { agentId: s.agentId },
          blockedByIssueIds: [s.doneBlockerId],
          nextCheckAt: "2026-10-20T00:00:00.000Z",
          timeoutAt: "2026-10-21T00:00:00.000Z",
          escalationPolicy: "agent",
        },
        unblockDescriptor: {
          owner: "board",
          action: "Waiting for the external check",
          reasonRef: { kind: "issue", issueId: s.doneBlockerId },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await statusOf(s)).toBe("blocked");
  });

  it("resets the streak when the blocker set changes", async () => {
    const s = await seed();
    const body = { unblockDescriptor: descriptorFor(s) };
    await returnTimes(s, 3, body);
    expect((await agentBlocks(s, body)).status).toBe(422);

    const changed = await agentBlocks(s, { ...body, blockedByIssueIds: [s.otherBlockerId] });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await statusOf(s)).toBe("blocked");
  });

  it("resets the streak when a new unblock descriptor is given", async () => {
    const s = await seed();
    const body = { unblockDescriptor: descriptorFor(s) };
    await returnTimes(s, 3, body);
    expect((await agentBlocks(s, body)).status).toBe(422);

    const changed = await agentBlocks(s, {
      unblockDescriptor: descriptorFor(s, "A different thing is awaited now"),
    });

    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(await statusOf(s)).toBe("blocked");
  });
});
