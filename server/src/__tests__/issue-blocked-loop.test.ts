// myrmidon(BLOCKED-LOOP): route-level test of the repeated-return limiter.
// An agent that keeps returning a task to `blocked` with the same blocker set
// and the same unblock descriptor is stopped after N returns with 422.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
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
    await db.delete(issues);
    await db.delete(heartbeatRuns);
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
        title: "Another done blocker",
        status: "done",
        priority: "medium",
        completedAt: new Date(),
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
      .send({ status: "blocked", ...body });
  }

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
    const body = { unblockDescriptor: descriptorFor(s) };
    await returnTimes(s, 3, body);
    expect((await agentBlocks(s, body)).status).toBe(422);

    await backToWork(s);
    const res = await request(createApp(boardActor(s.companyId)))
      .patch(`/api/issues/${s.issueId}`)
      .send({
        status: "blocked",
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
