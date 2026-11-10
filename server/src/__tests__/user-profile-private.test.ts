import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  issueComments,
  issueDocuments,
  documents,
  issues,
} from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type EmbeddedPostgresTestDatabase = Awaited<
  ReturnType<typeof startEmbeddedPostgresTestDatabase>
>;

type TestActor =
  | { type: "board"; source: "local_implicit"; userId?: string; companyIds: string[] }
  | { type: "agent"; source: "agent_key"; agentId: string; companyId: string };

type ActorRequest = Parameters<Parameters<typeof express.application.use>[1]>[0] & {
  actor: TestActor;
};

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let userProfileRoutes: typeof import("../routes/user-profiles.js").userProfileRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres user profile privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /companies/:companyId/users/:userSlug/profile privacy", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let companyId!: string;
  let userId!: string;
  let agentId!: string;
  const privateTitle = "Secret vendor migration plan";

  // The route module graph is huge; load it once outside any test's budget.
  // Nothing here mocks the route modules, so no per-test module reset is
  // needed (a reset inside beforeEach re-evaluates the graph and pushed the
  // first beforeEach past its hook timeout on a loaded host).
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-profile-private-");
    db = createDb(tempDb.connectionString);
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/user-profiles.js")>("../routes/user-profiles.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    userProfileRoutes = routes.userProfileRoutes;
    errorHandler = middleware.errorHandler;
  }, 180_000);

  beforeEach(async () => {
    companyId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Dotta",
      email: "dotta@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
    });
  });

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: { type: "board" | "agent"; userId?: string }) {
    if (!userProfileRoutes || !errorHandler) {
      throw new Error("user profile route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const payload: TestActor =
        actor.type === "board"
          ? {
              type: "board",
              source: "local_implicit",
              userId: actor.userId,
              companyIds: [companyId],
            }
          : {
              type: "agent",
              source: "agent_key",
              agentId,
              companyId,
            };
      (req as ActorRequest).actor = payload;
      next();
    });
    app.use("/api", userProfileRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // One ordinary issue and one private issue, each touched through a distinct
  // involvement path (created vs assigned vs commented) plus document activity.
  async function seedFixture() {
    const now = new Date();
    const newer = new Date(now.getTime() + 60_000);
    const older = new Date(now.getTime() - 60_000);
    const openIssueId = randomUUID();
    const privateIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const privateDocumentId = randomUUID();

    await db.insert(issues).values([
      {
        id: openIssueId,
        companyId,
        title: "Ship profile page",
        status: "in_progress",
        priority: "medium",
        assigneeUserId: userId,
        identifier: "PRV-1",
        createdAt: older,
        updatedAt: older,
      },
      {
        id: commentIssueId,
        companyId,
        title: "Review profile copy",
        status: "done",
        priority: "low",
        assigneeAgentId: agentId,
        identifier: "PRV-2",
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: privateIssueId,
        companyId,
        title: privateTitle,
        status: "done",
        priority: "high",
        createdByUserId: userId,
        isPrivate: true,
        identifier: "PRV-3",
        completedAt: now,
        createdAt: newer,
        updatedAt: newer,
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: commentIssueId,
        authorUserId: userId,
        body: "Public comment.",
        createdAt: now,
        updatedAt: now,
      },
      {
        companyId,
        issueId: privateIssueId,
        authorUserId: userId,
        body: "Private comment.",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(documents).values({
      id: privateDocumentId,
      companyId,
      title: "Private plan",
      format: "markdown",
      latestBody: "# Private plan",
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: privateIssueId,
      documentId: privateDocumentId,
      key: "plan",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.updated",
        entityType: "issue",
        entityId: privateIssueId,
        details: { title: privateTitle },
        createdAt: now,
      },
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: privateIssueId,
        details: { commentId: randomUUID(), issueTitle: privateTitle },
        createdAt: now,
      },
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.document_created",
        entityType: "issue",
        entityId: privateIssueId,
        details: { key: "plan", documentId: privateDocumentId, title: "Private plan" },
        createdAt: now,
      },
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.updated",
        entityType: "issue",
        entityId: openIssueId,
        details: { title: "Ship profile page" },
        createdAt: now,
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: openIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: 30,
        occurredAt: now,
      },
      {
        companyId,
        agentId,
        issueId: privateIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 200,
        cachedInputTokens: 20,
        outputTokens: 40,
        costCents: 60,
        occurredAt: now,
      },
    ]);

    return { openIssueId, privateIssueId };
  }

  it("hides the private issue from every field of the agent response", async () => {
    const { openIssueId } = await seedFixture();

    const response = await request(createApp({ type: "agent" })).get(
      `/api/companies/${companyId}/users/dotta/profile`,
    );

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(privateTitle);
    expect(serialized).not.toContain("PRV-3");

    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 2,
      createdIssues: 0,
      completedIssues: 1,
      assignedOpenIssues: 1,
      costCents: 30,
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 20,
      costEventCount: 1,
    });
    expect(
      response.body.recentIssues.map((issue: { identifier: string }) => issue.identifier),
    ).toEqual(["PRV-2", "PRV-1"]);
    expect(response.body.topAgents[0]).toMatchObject({ agentId, costCents: 30 });
    expect(response.body.topProviders[0]).toMatchObject({ provider: "openai", costCents: 30 });
    const activityEntityTypes = response.body.recentActivity.map(
      (entry: { entityType: string }) => entry.entityType,
    );
    // Only the public issue row survives; all private-issue-bound rows
    // (issue / issue_comment / issue_document) are dropped for an agent.
    expect(activityEntityTypes).toEqual(["issue"]);
    expect(response.body.recentActivity[0].entityId).toBe(openIssueId);
  });

  it("keeps the private issue visible in the board response", async () => {
    await seedFixture();

    const response = await request(createApp({ type: "board", userId })).get(
      `/api/companies/${companyId}/users/dotta/profile`,
    );

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain(privateTitle);
    expect(serialized).toContain("PRV-3");

    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 3,
      createdIssues: 1,
      completedIssues: 2,
      assignedOpenIssues: 1,
      costCents: 90,
      inputTokens: 300,
      cachedInputTokens: 30,
      outputTokens: 60,
      costEventCount: 2,
    });
    expect(
      response.body.recentIssues.map((issue: { identifier: string }) => issue.identifier),
    ).toEqual(["PRV-3", "PRV-2", "PRV-1"]);
    expect(response.body.topAgents[0]).toMatchObject({ agentId, costCents: 90 });
    expect(response.body.recentActivity).toHaveLength(4);
  });

  it("returns byte-identical agent and board bodies when the user has no private issues", async () => {
    const now = new Date();
    const onlyIssueId = randomUUID();
    await db.insert(issues).values({
      id: onlyIssueId,
      companyId,
      title: "Only public work",
      status: "in_progress",
      priority: "medium",
      createdByUserId: userId,
      identifier: "PRV-4",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: userId,
      action: "issue.updated",
      entityType: "issue",
      entityId: onlyIssueId,
      details: { title: "Only public work" },
      createdAt: now,
    });

    const boardResponse = await request(createApp({ type: "board", userId })).get(
      `/api/companies/${companyId}/users/dotta/profile`,
    );
    const agentResponse = await request(createApp({ type: "agent" })).get(
      `/api/companies/${companyId}/users/dotta/profile`,
    );

    expect(boardResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);
    expect(agentResponse.body).toEqual(boardResponse.body);
  });
});
