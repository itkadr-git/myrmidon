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
  issueDocuments,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  type Db,
} from "@myrmidon/db";
import type { EmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
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

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createApp(db: Db) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("issue private write paths (1.7 PRIVATE-TASKS E2)", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-private-write-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
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

  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function seed() {
    const company = await db.insert(companies).values({
      name: "Private Write Company",
      issuePrefix: `PW${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
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

    return { company, actorAgent, responsibleUserId, run, issue, boardToken, agentToken };
  }

  async function makePrivate(issueId: string) {
    await db.update(issues).set({ isPrivate: true }).where(eq(issues.id, issueId));
  }

  async function countRows(
    table: typeof issueComments | typeof issueDocuments | typeof issueWorkProducts | typeof issueThreadInteractions,
    issueId: string,
  ) {
    const rows = await db
      .select({ id: (table as typeof issueComments).id })
      .from(table as typeof issueComments)
      .where(eq((table as typeof issueComments).issueId, issueId));
    return rows.length;
  }

  /** Agent must get the flat 404 wall and leave zero write side effects. */
  async function expectAgentPrivate404(
    app: express.Express,
    fixture: Fixture,
    makeRequest: (r: request.Test) => request.Test,
    tables: Array<typeof issueComments | typeof issueDocuments | typeof issueWorkProducts | typeof issueThreadInteractions>,
  ) {
    const res = await makeRequest(request(app));
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
    for (const table of tables) {
      expect(await countRows(table, fixture.issue.id)).toBe(0);
    }
    const [after] = await db.select().from(issues).where(eq(issues.id, fixture.issue.id));
    expect(after!.status).toBe("in_progress");
    expect(after!.assigneeAgentId).toBe(fixture.actorAgent.id);
    expect(after!.isPrivate).toBe(true);
  }

  /** Auth headers for an agent request with run attribution. */
  function agentAuth(fixture: Fixture) {
    return {
      Authorization: `Bearer ${fixture.agentToken}`,
      "X-Paperclip-Run-Id": fixture.run.id,
    };
  }

  it("agent cannot POST a comment on a private issue (404, no rows)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(
      app,
      fixture,
      (r) => r.post(`/api/issues/${fixture.issue.id}/comments`).set(agentAuth(fixture)).send({ body: "sneaky comment" }),
      [issueComments],
    );
  }, 60_000);

  it("agent cannot PUT a document on a private issue (404, no rows)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(
      app,
      fixture,
      (r) => r.put(`/api/issues/${fixture.issue.id}/documents/plan`).set(agentAuth(fixture)).send({
        format: "markdown",
        body: "# secret plan",
        changeSummary: "secret",
      }),
      [issueDocuments],
    );
  }, 60_000);

  it("agent cannot POST an interaction on a private issue (404, no rows)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(
      app,
      fixture,
      (r) => r.post(`/api/issues/${fixture.issue.id}/interactions`).set(agentAuth(fixture)).send({
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: [
            {
              id: "q1",
              prompt: "Secret question?",
              selectionMode: "single",
              options: [{ id: "a", label: "Yes" }],
            },
          ],
        },
      }),
      [issueThreadInteractions],
    );
  }, 60_000);

  it("agent cannot POST a work product on a private issue (404, no rows)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(
      app,
      fixture,
      (r) => r.post(`/api/issues/${fixture.issue.id}/work-products`).set(agentAuth(fixture)).send({
        type: "preview_url",
        provider: "test",
        title: "Secret preview",
      }),
      [issueWorkProducts],
    );
  }, 60_000);

  it("agent cannot release a private issue (404, still assigned)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(app, fixture, (r) => r.post(`/api/issues/${fixture.issue.id}/release`).set(agentAuth(fixture)), []);
    const [after] = await db.select().from(issues).where(eq(issues.id, fixture.issue.id));
    expect(after!.assigneeAgentId).toBe(fixture.actorAgent.id);
  }, 60_000);

  it("agent cannot checkout a private issue (404, no lock)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(
      app,
      fixture,
      (r) => r
        .post(`/api/issues/${fixture.issue.id}/checkout`)
        .set(agentAuth(fixture))
        .send({ agentId: fixture.actorAgent.id, expectedStatuses: ["in_progress"] }),
      [],
    );
    const [after] = await db.select().from(issues).where(eq(issues.id, fixture.issue.id));
    expect(after!.checkoutRunId).toBeNull();
  }, 60_000);

  it("agent cannot delete a private issue (404)", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    await expectAgentPrivate404(app, fixture, (r) => r.delete(`/api/issues/${fixture.issue.id}`).set(agentAuth(fixture)), []);
    const [after] = await db.select().from(issues).where(eq(issues.id, fixture.issue.id));
    expect(after).toBeDefined();
  }, 60_000);

  it("board actor can still comment and document a private issue", async () => {
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    const auth = { Authorization: `Bearer ${fixture.boardToken}` };

    const commentRes = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .set(auth)
      .send({ body: "board sees everything" });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(await countRows(issueComments, fixture.issue.id)).toBe(1);

    const docRes = await request(app)
      .put(`/api/issues/${fixture.issue.id}/documents/plan`)
      .set(auth)
      .send({ format: "markdown", body: "# plan", changeSummary: "board plan" });
    expect(docRes.status, JSON.stringify(docRes.body)).toBe(201);
    expect(await countRows(issueDocuments, fixture.issue.id)).toBe(1);
  }, 60_000);

  it("agent write paths keep working on a public issue (control)", async () => {
    const fixture = await seed();
    const app = await createApp(db);
    const auth = { Authorization: `Bearer ${fixture.agentToken}`, "X-Paperclip-Run-Id": fixture.run.id };

    const commentRes = await request(app)
      .post(`/api/issues/${fixture.issue.id}/comments`)
      .set(auth)
      .send({ body: "public comment" });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const docRes = await request(app)
      .put(`/api/issues/${fixture.issue.id}/documents/plan`)
      .set(auth)
      .send({ format: "markdown", body: "# public plan" });
    expect(docRes.status, JSON.stringify(docRes.body)).toBe(201);

    const releaseRes = await request(app)
      .post(`/api/issues/${fixture.issue.id}/release`)
      .set(auth);
    expect(releaseRes.status, JSON.stringify(releaseRes.body)).toBe(200);
  }, 60_000);

  it("board-keyed queued-comment edit keeps working on a private issue", async () => {
    // The queued-comments routes gate on assertBoard before the loader, so an
    // agent structurally gets 403 there. The private wall for this family is
    // therefore exercised at the loader with the board key (must NOT 404).
    const fixture = await seed();
    await makePrivate(fixture.issue.id);
    const app = await createApp(db);
    const res = await request(app)
      .patch(`/api/issues/${fixture.issue.id}/queued-comments/${randomUUID()}`)
      .set("Authorization", `Bearer ${fixture.boardToken}`)
      .send({ body: "edit", queueId: "default", revision: "1" });
    // A missing comment id surfaces as 404/409 from the queue service — the
    // point of this assertion is that the private-issue loader did not 404
    // with the flat agent wall before the board gate.
    expect(res.status).not.toBe(401);
    expect(res.body.error).not.toBe("Issue not found");
  }, 60_000);
});
