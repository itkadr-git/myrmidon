import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  approvals,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
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
  const { approvalRoutes } = await import("../routes/approvals.js");
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.use("/api", approvalRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("approval routes private issues (1.7 PRIVATE-TASKS F1)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approvals-private-issues-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvals);
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
      name: "Approvals Privacy Company",
      issuePrefix: `AP${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const [actorAgent] = await db.insert(agents).values([{
      companyId: company.id,
      name: "Actor",
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }]).returning();
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
    const publicIssue = await db.insert(issues).values({
      companyId: company.id,
      issueNumber: 1,
      identifier: `${company.issuePrefix}-1`,
      title: "Public linked issue",
      description: "Public issue description",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: actorAgent.id,
    }).returning().then((rows) => rows[0]!);
    const privateIssue = await db.insert(issues).values({
      companyId: company.id,
      issueNumber: 2,
      identifier: `${company.issuePrefix}-2`,
      title: "Secret private linked issue",
      description: "Secret private description",
      status: "in_progress" as const,
      priority: "high" as const,
      isPrivate: true,
      assigneeAgentId: actorAgent.id,
    }).returning().then((rows) => rows[0]!);

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
      publicIssue,
      privateIssue,
      boardToken,
      agentToken,
    };
  }

  it("agent reading /approvals/:id/issues does not see the private linked issue; board sees both", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const createRes = await request(app)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [fixture.publicIssue.id, fixture.privateIssue.id],
      });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const approvalId = createRes.body.id;

    const boardRes = await request(app)
      .get(`/api/approvals/${approvalId}/issues`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardRes.status).toBe(200);
    expect(boardRes.body.some((i: any) => i.id === fixture.publicIssue.id)).toBe(true);
    expect(boardRes.body.some((i: any) => i.id === fixture.privateIssue.id)).toBe(true);

    const agentRes = await request(app)
      .get(`/api/approvals/${approvalId}/issues`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentRes.status).toBe(200);
    expect(agentRes.body.some((i: any) => i.id === fixture.publicIssue.id)).toBe(true);
    expect(agentRes.body.some((i: any) => i.id === fixture.privateIssue.id)).toBe(false);
    const serialized = JSON.stringify(agentRes.body);
    expect(serialized).not.toContain(fixture.privateIssue.id);
    expect(serialized).not.toContain(fixture.privateIssue.identifier);
    expect(serialized).not.toContain("Secret private linked issue");
    expect(serialized).not.toContain("Secret private description");
  }, 30_000);

  it("agent creating an approval with a private issueId gets 404 Issue not found and no approval row is created", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [fixture.privateIssue.id],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toContain("Issue not found");

    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(0);
  }, 30_000);

  it("agent creating an approval with mixed public and private issueIds gets 404 and nothing is created", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [fixture.publicIssue.id, fixture.privateIssue.id],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toContain("Issue not found");

    const approvalRows = await db.select().from(approvals);
    expect(approvalRows).toHaveLength(0);
    const linkRows = await db.select().from(issueApprovals);
    expect(linkRows).toHaveLength(0);
  }, 30_000);

  it("board can create an approval linked to a private issue", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [fixture.privateIssue.id],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const issuesRes = await request(app)
      .get(`/api/approvals/${res.body.id}/issues`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(issuesRes.status).toBe(200);
    expect(issuesRes.body.some((i: any) => i.id === fixture.privateIssue.id)).toBe(true);
  }, 30_000);

  it("agent creating an approval with only public issueIds still works", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${fixture.company.id}/approvals`)
      .set("Authorization", `Bearer ${fixture.agentToken}`)
      .send({
        type: "request_board_approval",
        payload: {},
        issueIds: [fixture.publicIssue.id],
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const issuesRes = await request(app)
      .get(`/api/approvals/${res.body.id}/issues`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(issuesRes.status).toBe(200);
    expect(issuesRes.body.some((i: any) => i.id === fixture.publicIssue.id)).toBe(true);
  }, 30_000);
});
