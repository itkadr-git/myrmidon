import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@myrmidon/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createApp(db: Db) {
  const { issueRoutes } = await import("../routes/issues.js");
  const { agentRoutes } = await import("../routes/agents.js");
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.use("/api", issueRoutes(db, {} as never));
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
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
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentApiKeys);
    await db.delete(boardApiKeys);
    await db.delete(companyMemberships);
    await db.delete(agentRuntimeState);
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
    await db.insert(companyMemberships).values([
      {
        companyId: company.id,
        principalType: "user",
        principalId: responsibleUserId,
        status: "active",
        membershipRole: "member",
      },
      {
        companyId: company.id,
        principalType: "user",
        principalId: boardUserId,
        status: "active",
        membershipRole: "admin",
      },
    ]);
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

    // Real credentials, as production issues them. Requests authenticate through
    // actorMiddleware rather than constructing req.actor in the test app.
    const boardToken = `board-test-token-${randomUUID()}`;
    await db.insert(boardApiKeys).values({
      userId: boardUserId,
      name: "Board Key",
      keyHash: hashToken(boardToken),
    });

    const agentToken = `agent-test-token-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: actorAgent.id,
      companyId: company.id,
      name: "Actor Agent Key",
      keyHash: hashToken(agentToken),
      responsibleUserId,
    });

    return {
      company,
      actorAgent,
      targetAgent,
      responsibleUserId,
      boardUserId,
      run,
      issue,
      boardToken,
      agentToken,
    };
  }

  it("board actor can create a private issue (isPrivate=true)", async () => {
    const fixture = await seed();
    const app = await createApp(db);
    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
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
    const app = await createApp(db);
    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
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
    const app = await createApp(db);
    const res = await request(app)
      .patch(`/api/issues/${fixture.issue.id}`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({ isPrivate: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.isPrivate).toBe(true);
  });

  it("agent actor receives 403 when toggling isPrivate on an existing issue", async () => {
    const fixture = await seed();
    const app = await createApp(db);
    const res = await request(app)
      .patch(`/api/issues/${fixture.issue.id}`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .send({ isPrivate: true });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("issue_write_private_flag_rejected");
  });

  it("agent actor receives 403 when clearing isPrivate on an existing private issue", async () => {
    const fixture = await seed();
    await db.update(issues)
      .set({ isPrivate: true })
      .where(eq(issues.id, fixture.issue.id));
    const app = await createApp(db);
    const res = await request(app)
      .patch(`/api/issues/${fixture.issue.id}`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .send({ isPrivate: false });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code).toBe("issue_write_private_flag_rejected");
  });

  it("agent actor receives 403 when creating a child issue with isPrivate=true", async () => {
    const fixture = await seed();
    const app = await createApp(db);
    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/children`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
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
    const app = await createApp(db);
    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/children`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
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
    const app = await createApp(db);
    const res = await request(app)
      .post(`/api/issues/${fixture.issue.id}/accepted-plan-decompositions`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .set("X-Paperclip-Run-Id", fixture.run.id)
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
    const app = await createApp(db);

    const createRes = await request(app)
      .post(`/api/companies/${fixture.company.id}/issues`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({
        title: "Secret super secret private task",
        status: "todo",
        priority: "high",
        isPrivate: true,
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const privateIssueId = createRes.body.id;

    // 1. Company issue list
    const boardListRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/issues`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardListRes.status).toBe(200);
    expect(boardListRes.body.some((i: any) => i.id === privateIssueId)).toBe(true);

    const agentListRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/issues`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentListRes.status).toBe(200);
    expect(agentListRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);
    expect(JSON.stringify(agentListRes.body)).not.toContain("Secret super secret private task");

    // 2. Issue q= search
    const boardSearchRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/issues?q=Secret`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardSearchRes.status).toBe(200);
    expect(boardSearchRes.body.some((i: any) => i.id === privateIssueId)).toBe(true);

    const agentSearchRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/issues?q=Secret`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentSearchRes.status).toBe(200);
    expect(agentSearchRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);
    expect(JSON.stringify(agentSearchRes.body)).not.toContain("Secret super secret private task");

    // 3. Direct GET -> 404 for agent, 200 for board
    const agentGetRes = await request(app)
      .get(`/api/issues/${privateIssueId}`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentGetRes.status).toBe(404);

    const boardGetRes = await request(app)
      .get(`/api/issues/${privateIssueId}`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardGetRes.status).toBe(200);
    expect(boardGetRes.body.isPrivate).toBe(true);

    // 4. Heartbeat context -> 404 for agent
    const agentHbRes = await request(app)
      .get(`/api/issues/${privateIssueId}/heartbeat-context`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentHbRes.status).toBe(404);

    // 5. Comments -> 404 for agent
    const agentCommentsRes = await request(app)
      .get(`/api/issues/${privateIssueId}/comments`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentCommentsRes.status).toBe(404);

    // 6. Inbox-lite -> hidden from agent even when assigned to the agent
    const assignRes = await request(app)
      .patch(`/api/issues/${privateIssueId}`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({ assigneeAgentId: fixture.actorAgent.id });
    expect(assignRes.status).toBe(200);

    const agentInboxRes = await request(app)
      .get("/api/agents/me/inbox-lite")
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentInboxRes.status).toBe(200);
    expect(agentInboxRes.body.some((i: any) => i.id === privateIssueId)).toBe(false);
    expect(JSON.stringify(agentInboxRes.body)).not.toContain("Secret super secret private task");

    // 7. Company search; verify that the private issue is absent from every result
    // field (including snippets), not only from the direct issue-list endpoint.
    const boardCompanySearchRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/search?q=Secret`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardCompanySearchRes.status).toBe(200);
    expect(
      boardCompanySearchRes.body.results?.some((r: any) => r.id === privateIssueId),
    ).toBe(true);

    const agentCompanySearchRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/search?q=Secret`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentCompanySearchRes.status).toBe(200);
    expect(JSON.stringify(agentCompanySearchRes.body)).not.toContain(privateIssueId);
    expect(JSON.stringify(agentCompanySearchRes.body)).not.toContain("Secret super secret private task");

    // Assignment must not change the agent's access to the issue or related reads.
    expect((await request(app).get(`/api/issues/${privateIssueId}`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/heartbeat-context`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/comments`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/execution`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/activity`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/costs`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/issues/${privateIssueId}/cases`).set("Authorization", `Bearer ${fixture.agentToken}`)).status).toBe(404);
  });
});
