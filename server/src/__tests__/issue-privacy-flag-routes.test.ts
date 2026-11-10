import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { issueRoutes } = await import("../routes/issues.js");
  const { agentRoutes } = await import("../routes/agents.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use("/api", agentRoutes(db));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres("issue privacy flag routes (1.7 PRIVATE-TASKS)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-privacy-flag-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Privacy Company",
      issuePrefix: `PR${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [actorAgent, targetAgent] = await db.insert(agents).values(["Actor", "Target"].map((name) => ({
      companyId: company.id,
      name,
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }))).returning();
    const responsibleUserId = `responsible-${randomUUID()}`;
    const boardUserId = `board-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([
      {
        id: responsibleUserId,
        name: "Responsible User",
        email: `${responsibleUserId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: boardUserId,
        name: "Board User",
        email: `${boardUserId}@example.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: responsibleUserId,
      status: "active",
      membershipRole: "member",
    });
    const issue = await db.insert(issues).values({
      companyId: company.id,
      issueNumber: 1,
      identifier: `${company.issuePrefix}-1`,
      title: "Target issue",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: actorAgent.id,
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: actorAgent.id,
      status: "running",
      responsibleUserId,
      contextSnapshot: { issueId: issue.id },
    }).returning().then((rows) => rows[0]!);

    return { company, actorAgent, targetAgent, responsibleUserId, boardUserId, run, issue };
  }

  function agentActor(input: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: input.actorAgent.id,
      companyId: input.company.id,
      runId: input.run.id,
      onBehalfOfUserId: input.responsibleUserId,
      onBehalfOfMemberships: [{
        companyId: input.company.id,
        membershipRole: "member",
        status: "active",
      }],
      source: "agent_jwt",
    };
  }

  function boardActor(input: Awaited<ReturnType<typeof seed>>): Express.Request["actor"] {
    return {
      type: "board",
      userId: input.boardUserId,
      companyIds: [input.company.id],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
  }

  it("board actor can create a private issue (isPrivate=true)", async () => {
    const fixture = await seed();
    const boardApp = await createApp(db, boardActor(fixture));
    const res = await request(boardApp)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .send({
        title: "Board private task",
        status: "todo",
        priority: "high",
        isPrivate: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.isPrivate).toBe(true);
  }, 30_000);

  it("agent actor receives 403 when creating a private issue", async () => {
    const fixture = await seed();
    const agentApp = await createApp(db, agentActor(fixture));
    const res = await request(agentApp)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .send({
        title: "Agent private task",
        status: "todo",
        priority: "medium",
        isPrivate: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board actors can set isPrivate");
  });

  it("board actor can toggle isPrivate on an existing issue", async () => {
    const fixture = await seed();
    const boardApp = await createApp(db, boardActor(fixture));
    const res = await request(boardApp)
      .patch(`/api/issues/${fixture.issue.id}`)
      .send({ isPrivate: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.isPrivate).toBe(true);
  });

  it("agent actor receives 403 when toggling isPrivate on an existing issue", async () => {
    const fixture = await seed();
    const agentApp = await createApp(db, agentActor(fixture));
    const res = await request(agentApp)
      .patch(`/api/issues/${fixture.issue.id}`)
      .send({ isPrivate: true });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("issue_write_private_flag_rejected");
  });

  it("agent actor receives 403 when clearing isPrivate on an existing private issue", async () => {
    const fixture = await seed();
    await db.update(issues)
      .set({ isPrivate: true })
      .where(eq(issues.id, fixture.issue.id));
    const agentApp = await createApp(db, agentActor(fixture));
    const res = await request(agentApp)
      .patch(`/api/issues/${fixture.issue.id}`)
      .send({ isPrivate: false });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("issue_write_private_flag_rejected");
  });

  it("agent actor receives 403 when creating a child issue with isPrivate=true", async () => {
    const fixture = await seed();
    const agentApp = await createApp(db, agentActor(fixture));
    const res = await request(agentApp)
      .post(`/api/issues/${fixture.issue.id}/children`)
      .send({
        title: "Agent private child",
        status: "todo",
        priority: "medium",
        isPrivate: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board actors can set isPrivate");
  });

  it("board actor can create a child issue with isPrivate=true", async () => {
    const fixture = await seed();
    const boardApp = await createApp(db, boardActor(fixture));
    const res = await request(boardApp)
      .post(`/api/issues/${fixture.issue.id}/children`)
      .send({
        title: "Board private child",
        status: "todo",
        priority: "medium",
        isPrivate: true,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.isPrivate).toBe(true);
  });

  it("agent actor receives 403 when decomposing a plan with a private child", async () => {
    const fixture = await seed();
    const agentApp = await createApp(db, agentActor(fixture));
    const res = await request(agentApp)
      .post(`/api/issues/${fixture.issue.id}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: randomUUID(),
        children: [
          {
            title: "Agent private plan child",
            status: "todo",
            priority: "medium",
            isPrivate: true,
          },
        ],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board actors can set isPrivate");
  });

  it("private issue is hidden from agent reads (list, search, inbox-lite, heartbeat-context, direct get, comments) but visible to board", async () => {
    const fixture = await seed();
    const boardApp = await createApp(db, boardActor(fixture));
    const agentApp = await createApp(db, agentActor(fixture));

    const createRes = await request(boardApp)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .send({
        title: "Secret super secret private task",
        status: "todo",
        priority: "high",
        isPrivate: true,
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const privateIssueId = createRes.body.id;

    // 1. List
    const boardListRes = await request(boardApp)
      .get(`/api/companies/${fixture.company.id}/issues`);
    expect(boardListRes.status).toBe(200);
    expect(boardListRes.body.some((i: any) => i.id === privateIssueId)).toBe(true);

    const agentListRes = await request(agentApp)
      .get(`/api/companies/${fixture.company.id}/issues`);
    expect(agentListRes.status).toBe(200);
    expect(agentListRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);

    // 2. Search (q=)
    const boardSearchRes = await request(boardApp)
      .get(`/api/companies/${fixture.company.id}/issues?q=Secret`);
    expect(boardSearchRes.status).toBe(200);
    expect(boardSearchRes.body.some((i: any) => i.id === privateIssueId)).toBe(true);

    const agentSearchRes = await request(agentApp)
      .get(`/api/companies/${fixture.company.id}/issues?q=Secret`);
    expect(agentSearchRes.status).toBe(200);
    expect(agentSearchRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);

    // 3. Direct GET -> 404 for agent, 200 for board
    const agentGetRes = await request(agentApp)
      .get(`/api/issues/${privateIssueId}`);
    expect(agentGetRes.status).toBe(404);

    const boardGetRes = await request(boardApp)
      .get(`/api/issues/${privateIssueId}`);
    expect(boardGetRes.status).toBe(200);
    expect(boardGetRes.body.isPrivate).toBe(true);

    // 4. Heartbeat context -> 404 for agent
    const agentHbRes = await request(agentApp)
      .get(`/api/issues/${privateIssueId}/heartbeat-context`);
    expect(agentHbRes.status).toBe(404);

    // 5. Comments -> 404 for agent
    const agentCommentsRes = await request(agentApp)
      .get(`/api/issues/${privateIssueId}/comments`);
    expect(agentCommentsRes.status).toBe(404);

    // 6. Inbox-lite -> hidden from agent even when assigned to the agent
    const assignRes = await request(boardApp)
      .patch(`/api/issues/${privateIssueId}`)
      .send({ assigneeAgentId: fixture.actorAgent.id });
    expect(assignRes.status).toBe(200);

    const agentInboxRes = await request(agentApp)
      .get("/api/agents/me/inbox-lite");
    expect(agentInboxRes.status).toBe(200);
    expect(agentInboxRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);

    // 7. Company search (/companies/:companyId/search) -> hidden from agent, visible to board
    const boardCompanySearchRes = await request(boardApp)
      .get(`/api/companies/${fixture.company.id}/search?q=Secret`);
    expect(boardCompanySearchRes.status).toBe(200);
    expect(
      boardCompanySearchRes.body.issues?.some((i: any) => i.id === privateIssueId),
    ).toBe(true);

    const agentCompanySearchRes = await request(agentApp)
      .get(`/api/companies/${fixture.company.id}/search?q=Secret`);
    expect(agentCompanySearchRes.status).toBe(200);
    expect(
      agentCompanySearchRes.body.issues?.some((i: any) => i.id === privateIssueId),
    ).toBe(false);

    // 8. Also hidden after re-assigning to agent (direct GET / heartbeat-context / comments)
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/heartbeat-context`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/comments`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/execution`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/activity`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/costs`)).status).toBe(404);
    expect((await request(agentApp).get(`/api/issues/${privateIssueId}/cases`)).status).toBe(404);
  });
});
