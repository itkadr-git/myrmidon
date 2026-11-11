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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type * as MiddlewareModule from "../middleware/index.js";
import type * as UserProfilesModule from "../routes/user-profiles.js";

let errorHandler: MiddlewareModule["errorHandler"];
let userProfileRoutes: UserProfilesModule["userProfileRoutes"];

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres user profile privacy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Actor = { type: "board" | "agent"; [key: string]: unknown };

describeEmbeddedPostgres("GET /companies/:companyId/users/:userSlug/profile (private issues)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let userId!: string;
  let agentId!: string;
  const privateTitle = "Owner private compensation notes";

  function createApp(actor: Actor) {
    if (!userProfileRoutes || !errorHandler) {
      throw new Error("user profile route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Test seam: inject the authenticated actor the real auth middleware would set.
      const actorRequest = req as express.Request & { actor?: Actor };
      actorRequest.actor = actor;
      next();
    });
    app.use("/api", userProfileRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function fetchProfile(actor: Actor) {
    return request(createApp(actor)).get(`/api/companies/${companyId}/users/dotta/profile`);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-profile-private-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/user-profiles.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<UserProfilesModule>("../routes/user-profiles.js"),
      vi.importActual<MiddlewareModule>("../middleware/index.js"),
    ]);
    userProfileRoutes = routes.userProfileRoutes;
    errorHandler = middleware.errorHandler;
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

  /**
   * Seed one normal issue plus optionally one private issue, each with a
   * comment, activity rows, and cost events. When `withPrivate`, activity for
   * the private issue additionally covers every shape that resolves back to a
   * private issue: the production shape (entityType "issue", entityId = issue
   * id) and the historical shapes (entityType "issue_comment" /
   * "issue_document" with the comment/document id in entity_id).
   */
  async function seedIssues(options: { withPrivate?: boolean } = {}) {
    const withPrivate = options.withPrivate ?? true;
    const now = new Date();
    const normalId = randomUUID();
    const privateId = withPrivate ? randomUUID() : null;
    const rows: (typeof issues.$inferInsert)[] = [
      {
        id: normalId,
        companyId,
        title: "Ship profile page",
        status: "done",
        priority: "high",
        createdByUserId: userId,
        identifier: "PRV-1",
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ];
    if (privateId) {
      rows.push({
        id: privateId,
        companyId,
        title: privateTitle,
        status: "in_progress",
        priority: "medium",
        createdByUserId: userId,
        assigneeUserId: userId,
        isPrivate: true,
        identifier: "PRV-2",
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(issues).values(rows);
    const commentRows: (typeof issueComments.$inferInsert)[] = [
      {
        companyId,
        issueId: normalId,
        authorUserId: userId,
        body: "Looks good.",
        createdAt: now,
        updatedAt: now,
      },
    ];
    const activityRows: (typeof activityLog.$inferInsert)[] = [
      {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.updated",
        entityType: "issue",
        entityId: normalId,
        createdAt: now,
      },
    ];
    const costRows: (typeof costEvents.$inferInsert)[] = [
      {
        companyId,
        agentId,
        issueId: normalId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 120,
        cachedInputTokens: 30,
        outputTokens: 40,
        costCents: 42,
        occurredAt: now,
      },
    ];
    let privateCommentId: string | null = null;
    let privateDocumentId: string | null = null;
    let issueDocumentId: string | null = null;
    if (privateId) {
      privateCommentId = randomUUID();
      commentRows.push({
        id: privateCommentId,
        companyId,
        issueId: privateId,
        authorUserId: userId,
        body: "Confidential context.",
        createdAt: now,
        updatedAt: now,
      });
      activityRows.push(
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "issue.updated",
          entityType: "issue",
          entityId: privateId,
          createdAt: now,
        },
        {
          companyId,
          actorType: "user",
          actorId: userId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: privateId,
          createdAt: now,
        },
      );
      costRows.push({
        companyId,
        agentId,
        issueId: privateId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-test",
        inputTokens: 500,
        cachedInputTokens: 50,
        outputTokens: 100,
        costCents: 77,
        occurredAt: now,
      });
    }
    await db.insert(issueComments).values(commentRows);
    if (privateId && privateCommentId) {
      // The reviewer-blocking shapes: entity_id names the comment id (not the
      // issue id). Both must resolve to the private issue and be dropped for
      // agents.
      activityRows.push({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.comment_added",
        entityType: "issue_comment",
        entityId: privateCommentId,
        createdAt: now,
      });
      issueDocumentId = randomUUID();
      privateDocumentId = randomUUID();
      await db.insert(documents).values({
        id: privateDocumentId,
        companyId,
        title: "Secret private document",
        latestBody: "Confidential document body.",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(issueDocuments).values({
        id: issueDocumentId,
        companyId,
        issueId: privateId,
        documentId: privateDocumentId,
        key: "private-plan",
        createdAt: now,
        updatedAt: now,
      });
      activityRows.push({
        companyId,
        actorType: "user",
        actorId: userId,
        action: "issue.document_created",
        entityType: "issue_document",
        entityId: issueDocumentId,
        createdAt: now,
      });
    }
    await db.insert(activityLog).values(activityRows);
    await db.insert(costEvents).values(costRows);
    return { normalId, privateId };
  }

  const boardActor = (): Actor => ({ type: "board", source: "local_implicit", userId, companyIds: [companyId] });
  const agentActor = (): Actor => ({ type: "agent", agentId, companyId, runId: null, source: "agent_key" });

  it("hides the private issue and its footprint from the agent profile response", async () => {
    const { privateId } = await seedIssues();

    const response = await fetchProfile(agentActor());

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(privateTitle);
    expect(serialized).not.toContain(privateId);
    // The private issue's plan document and its comment must not surface via
    // recentActivity either — including through the issue_document /
    // issue_comment entity-id shapes.
    expect(serialized).not.toContain("Secret private document");

    expect(response.body.recentIssues.map((issue: { id: string }) => issue.id)).not.toContain(privateId);
    expect(response.body.recentIssues.map((issue: { identifier: string }) => issue.identifier)).toEqual(["PRV-1"]);

    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 1,
      createdIssues: 1,
      completedIssues: 1,
      assignedOpenIssues: 0,
      commentCount: 1,
      // activityCount: 1 public "issue" row; the private "issue",
      // "issue_comment" (comment-id entity) and "issue_document"
      // (issue-document-id entity) rows are all resolved to the private issue
      // and dropped.
      activityCount: 1,
      costCents: 42,
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 40,
      costEventCount: 1,
    });

    expect(response.body.recentActivity).toHaveLength(1);
    expect(response.body.recentActivity[0].entityId).not.toBe(privateId);
    expect(response.body.recentActivity[0].entityType).toBe("issue");

    expect(response.body.topAgents[0]).toMatchObject({ agentId, costCents: 42 });
    expect(response.body.topProviders[0]).toMatchObject({ costCents: 42 });

    const dailyTotal = response.body.daily.reduce(
      (sum: number, point: { costCents: number }) => sum + point.costCents,
      0,
    );
    expect(dailyTotal).toBe(42);
    const dailyActivity = response.body.daily.reduce(
      (sum: number, point: { activityCount: number }) => sum + point.activityCount,
      0,
    );
    expect(dailyActivity).toBe(1);
  });

  it("keeps the private issue visible and counted for board requests", async () => {
    const { privateId } = await seedIssues();

    const response = await fetchProfile(boardActor());

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain(privateTitle);

    expect(response.body.recentIssues.map((issue: { id: string }) => issue.id)).toContain(privateId);

    const all = response.body.stats.find((entry: { key: string }) => entry.key === "all");
    expect(all).toMatchObject({
      touchedIssues: 2,
      createdIssues: 2,
      completedIssues: 1,
      assignedOpenIssues: 1,
      commentCount: 2,
      // 1 public "issue" row + private "issue", "issue_comment" (comment id),
      // "issue_document" (issue-document id) rows.
      activityCount: 5,
      costCents: 119,
      inputTokens: 620,
      cachedInputTokens: 80,
      outputTokens: 140,
      costEventCount: 2,
    });

    expect(response.body.recentActivity.some((row: { entityId: string }) => row.entityId === privateId)).toBe(true);
    expect(
      response.body.recentActivity.some((row: { entityType: string }) => row.entityType === "issue_comment"),
    ).toBe(true);
    expect(
      response.body.recentActivity.some((row: { entityType: string }) => row.entityType === "issue_document"),
    ).toBe(true);

    expect(response.body.topAgents[0]).toMatchObject({ agentId, costCents: 119 });
    expect(response.body.topProviders[0]).toMatchObject({ costCents: 119 });
  });

  it("returns identical agent and board payloads when the user has no private issues", async () => {
    await seedIssues({ withPrivate: false });

    const agentResponse = await fetchProfile(agentActor());
    const boardResponse = await fetchProfile(boardActor());

    expect(agentResponse.status).toBe(200);
    expect(boardResponse.status).toBe(200);
    expect(agentResponse.body).toEqual(boardResponse.body);
  });
});
