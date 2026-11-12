import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  principalPermissionGrants,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createApp(db: Db) {
  const { costRoutes } = await import("../routes/costs.js");
  const { activityRoutes } = await import("../routes/activity.js");
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: async () => null,
    }),
  );
  app.use("/api", costRoutes(db));
  app.use("/api", activityRoutes(db));
  app.use(errorHandler);
  return app;
}
describeEmbeddedPostgres("issue private reports (1.7 PRIVATE-TASKS F3)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-private-reports-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agentApiKeys);
    await db.delete(boardApiKeys);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seed() {
    const company = await db.insert(companies).values({
      name: "Private Reports Company",
      issuePrefix: `PR${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const workerAgent = await db.insert(agents).values({
      companyId: company.id,
      name: "Reports Worker",
      role: "engineer",
      status: "active" as const,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
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
    const [privateIssue, publicIssueA, publicIssueB] = await db.insert(issues).values([
      {
        companyId: company.id,
        issueNumber: 1,
        identifier: `${company.issuePrefix}-1`,
        title: "Secret private issue title",
        status: "todo" as const,
        priority: "high" as const,
        isPrivate: true,
      },
      {
        companyId: company.id,
        issueNumber: 2,
        identifier: `${company.issuePrefix}-2`,
        title: "Public issue alpha",
        status: "todo" as const,
        priority: "medium" as const,
      },
      {
        companyId: company.id,
        issueNumber: 3,
        identifier: `${company.issuePrefix}-3`,
        title: "Public issue beta",
        status: "todo" as const,
        priority: "low" as const,
      },
    ]).returning();

    // The private issue carries the highest spend, a comment, and a document.
    const occurredAt = new Date("2026-07-21T00:00:00.000Z");
    await db.insert(costEvents).values([
      {
        companyId: company.id,
        agentId: workerAgent.id,
        issueId: privateIssue.id,
        provider: "openai",
        biller: "unknown",
        billingType: "unknown",
        costStatus: "reported",
        model: "test-model",
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 900,
        occurredAt,
      },
      {
        companyId: company.id,
        agentId: workerAgent.id,
        issueId: publicIssueA.id,
        provider: "openai",
        biller: "unknown",
        billingType: "unknown",
        costStatus: "reported",
        model: "test-model",
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 50,
        costCents: 500,
        occurredAt,
      },
      {
        companyId: company.id,
        agentId: workerAgent.id,
        issueId: publicIssueB.id,
        provider: "openai",
        biller: "unknown",
        billingType: "unknown",
        costStatus: "reported",
        model: "test-model",
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 10,
        costCents: 100,
        occurredAt,
      },
    ]);

    const privateComment = await db.insert(issueComments).values({
      companyId: company.id,
      issueId: privateIssue.id,
      authorAgentId: workerAgent.id,
      body: "Private issue comment body with secret details",
    }).returning().then((rows) => rows[0]!);
    const privateDocument = await db.insert(documents).values({
      companyId: company.id,
      title: "Private plan",
      latestBody: "Private plan body",
      createdByAgentId: workerAgent.id,
      updatedByAgentId: workerAgent.id,
    }).returning().then((rows) => rows[0]!);
    const privateIssueDocument = await db.insert(issueDocuments).values({
      companyId: company.id,
      issueId: privateIssue.id,
      documentId: privateDocument.id,
      key: "plan",
    }).returning().then((rows) => rows[0]!);

    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: workerAgent.id,
      status: "running",
    }).returning().then((rows) => rows[0]!);

    const base = new Date("2026-07-21T01:00:00.000Z");
    await db.insert(activityLog).values([
      {
        companyId: company.id,
        actorType: "agent",
        actorId: workerAgent.id,
        action: "issue.comment.created",
        entityType: "issue_comment",
        entityId: privateComment.id,
        agentId: workerAgent.id,
        runId: run.id,
        details: { excerpt: "Private issue comment body with secret details" },
        createdAt: new Date(base.getTime() + 4000),
      },
      {
        companyId: company.id,
        actorType: "system",
        actorId: "system",
        action: "issue.document.updated",
        entityType: "issue_document",
        entityId: privateIssueDocument.id,
        agentId: workerAgent.id,
        runId: run.id,
        details: { key: "plan" },
        createdAt: new Date(base.getTime() + 3000),
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: workerAgent.id,
        action: "issue.updated",
        entityType: "issue",
        entityId: privateIssue.id,
        agentId: workerAgent.id,
        details: { title: "Secret private issue title" },
        createdAt: new Date(base.getTime() + 2000),
      },
      {
        companyId: company.id,
        actorType: "agent",
        actorId: workerAgent.id,
        action: "issue.updated",
        entityType: "issue",
        entityId: publicIssueA.id,
        agentId: workerAgent.id,
        details: { title: "Public issue alpha" },
        createdAt: new Date(base.getTime() + 1000),
      },
    ]);

    // Real credentials, as production issues them. Requests authenticate
    // through actorMiddleware rather than constructing req.actor in the app.
    // Agent keys require a responsible user (middleware 403s without one), so
    // the fixture mirrors the production key issuance.
    const boardToken = `board-test-token-${randomUUID()}`;
    await db.insert(boardApiKeys).values({
      userId: boardUserId,
      name: "Board Key",
      keyHash: hashToken(boardToken),
    });
    const agentToken = `agent-test-token-${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: workerAgent.id,
      companyId: company.id,
      name: "Worker Agent Key",
      keyHash: hashToken(agentToken),
      responsibleUserId,
    });
    // The board user holds the explicit audit permission, mirroring the
    // production audit-reader setup; the CSV/JSONL export routes require it.
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: boardUserId,
      permissionKey: "audit:view_agent_actions",
      scope: null,
      grantedByUserId: null,
    });

    return {
      company,
      workerAgent,
      privateIssue,
      publicIssueA,
      publicIssueB,
      privateComment,
      privateIssueDocument,
      boardToken,
      agentToken,
    };
  }

  it("agent costs/by-issue skips the private issue and fills the limit with public ones; board sees it", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const agentRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/costs/by-issue?limit=2`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(200);
    expect(agentRes.body).toHaveLength(2);
    expect(agentRes.body.some((row: { issueId: string }) => row.issueId === fixture.privateIssue.id)).toBe(false);
    expect(agentRes.body.map((row: { identifier: string }) => row.identifier)).toEqual([
      fixture.publicIssueA.identifier,
      fixture.publicIssueB.identifier,
    ]);
    expect(JSON.stringify(agentRes.body)).not.toContain("Secret private issue title");

    const boardRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/costs/by-issue?limit=2`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardRes.status).toBe(200);
    expect(boardRes.body).toHaveLength(2);
    expect(boardRes.body[0]).toMatchObject({
      issueId: fixture.privateIssue.id,
      identifier: fixture.privateIssue.identifier,
      title: "Secret private issue title",
      costCents: 900,
    });
  }, 30_000);

  it("agent audit/agent-actions hides private-issue rows and walks the cursor without gaps", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const collected: Array<{ id: string; entityType: string; entityId: string }> = [];
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const res = await request(app)
        .get(`/api/companies/${fixture.company.id}/audit/agent-actions?actorScope=all&limit=1${cursorQuery}`)
        .set("Authorization", `Bearer ${fixture.agentToken}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.items).toHaveLength(1);
      collected.push(...res.body.items);
      cursor = res.body.nextCursor;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor);

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      entityType: "issue",
      entityId: fixture.publicIssueA.id,
    });

    const text = JSON.stringify(collected);
    expect(text).not.toContain("Secret private issue title");
    expect(text).not.toContain("Private issue comment body with secret details");
    expect(text).not.toContain(fixture.privateIssue.id);
    expect(text).not.toContain(fixture.privateComment.id);
  }, 30_000);

  it("agent service-level exclusion: entityId of a private issue or its comment yields an empty page", async () => {
    const fixture = await seed();
    const { agentActionAuditService } = await import("../services/agent-action-audit.js");
    const audit = agentActionAuditService(db);

    // Agents cannot pass attribution filters on the route (403, fail-closed),
    // so the entityId bypass guard is asserted at the service level — the same
    // SQL the route executes.
    const byPrivateIssue = await audit.list({
      companyId: fixture.company.id,
      actorScope: "all",
      entityId: fixture.privateIssue.id,
      limit: 50,
      excludePrivate: true,
    });
    expect(byPrivateIssue.items).toHaveLength(0);
    expect(byPrivateIssue.nextCursor).toBeNull();

    const byPrivateComment = await audit.list({
      companyId: fixture.company.id,
      actorScope: "all",
      entityId: fixture.privateComment.id,
      limit: 50,
      excludePrivate: true,
    });
    expect(byPrivateComment.items).toHaveLength(0);
    expect(byPrivateComment.nextCursor).toBeNull();

    const byCommentEntityType = await audit.list({
      companyId: fixture.company.id,
      actorScope: "all",
      entityType: "issue_comment",
      limit: 50,
      excludePrivate: true,
    });
    expect(byCommentEntityType.items).toHaveLength(0);
  }, 30_000);

  it("board audit/agent-actions still sees the private-issue rows with details", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    const res = await request(app)
      .get(`/api/companies/${fixture.company.id}/audit/agent-actions?actorScope=all&limit=50`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items).toHaveLength(4);
    const commentRow = res.body.items.find((item: { entityId: string }) => item.entityId === fixture.privateComment.id);
    expect(commentRow).toBeDefined();
    expect(commentRow.entity.issue).toMatchObject({ identifier: fixture.privateIssue.identifier, title: "Secret private issue title" });
    expect(commentRow.entity.comment.excerpt).toContain("Private issue comment body");
    expect(commentRow.details).toMatchObject({ excerpt: "Private issue comment body with secret details" });
  }, 30_000);

  it("agent audit JSONL export keeps the route permission wall; board export keeps private rows", async () => {
    const fixture = await seed();
    const app = await createApp(db);

    // The CSV/JSONL export routes are board-only (assertAgentAuditPermission →
    // assertBoard); route permissions are unchanged by this task, so an agent
    // key cannot walk the export at all. The excludePrivate flag stays wired
    // into the export path as defense-in-depth (it is the same agentAudit.list
    // call the export loops over, covered with excludePrivate=true by the
    // cursor-walk test above).
    const agentRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/audit/agent-actions.jsonl?actorScope=all`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(agentRes.status).toBe(403);

    const boardRes = await request(app)
      .get(`/api/companies/${fixture.company.id}/audit/agent-actions.jsonl?actorScope=all`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(boardRes.status, boardRes.text).toBe(200);
    expect(boardRes.headers["x-audit-row-count"]).toBe("4");
    expect(boardRes.text).toContain("Secret private issue title");
    expect(boardRes.text).toContain("Private issue comment body with secret details");
  }, 30_000);

  it("board agent-actions.csv still lists the private issue", async () => {
    const fixture = await seed();
    const app = await createApp(db);
    const res = await request(app)
      .get(`/api/companies/${fixture.company.id}/audit/agent-actions.csv`)
      .set("Authorization", `Bearer ${fixture.boardToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(fixture.privateIssue.identifier);
    expect(res.text).toContain("Secret private issue title");
  }, 30_000);

  it("agent by-issue keeps board-visible totals after a private flag toggle (no stale cache)", async () => {
    const fixture = await seed();
    await db.update(issues)
      .set({ isPrivate: false })
      .where(eq(issues.id, fixture.privateIssue.id));
    const app = await createApp(db);
    const res = await request(app)
      .get(`/api/companies/${fixture.company.id}/costs/by-issue?limit=2`)
      .set("Authorization", `Bearer ${fixture.agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.some((row: { issueId: string }) => row.issueId === fixture.privateIssue.id)).toBe(true);
  });
});
