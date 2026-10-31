import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { boardApiKeys, userBlocks, createDb, companies } from "@myrmidon/db";
import { createBoardApiToken, hashBearerToken } from "../services/board-api-keys.js";
import { actorMiddleware } from "../middleware/actor.js";
import { errorHandler } from "../middleware/error-handler.js";
import { usersAdminRoutes } from "../myrmidon/users-admin-a/routes.js";
import { usersRoutes } from "../routes/users.js";
import { auditRoutes } from "../routes/audit.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const BASE = "https://board.example.test";
const PASSWORD = "correct-horse-battery-staple";
type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const admin: Actor = {
  type: "board",
  userId: "admin-user",
  source: "session",
  isInstanceAdmin: true,
  companyIds: [],
} as unknown as Actor;

const member: Actor = {
  type: "board",
  userId: "member-user",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [],
} as unknown as Actor;

const agent: Actor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
} as unknown as Actor;

const anonymous: Actor = { type: "none", source: "none" } as unknown as Actor;

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", usersAdminRoutes(db, { authPublicBaseUrl: BASE }));
  app.use("/api", usersRoutes(db));
  app.use("/api", auditRoutes(db));
  app.use(errorHandler);
  return app;
}

describePostgres("user block API with audit (OPE-10215)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let testCompanyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-users-block-");
    db = createDb(tempDb.connectionString);

    // Create a test company for activity log foreign key reference
    const [c] = await db.insert(companies).values({ name: "Acme Corp" }).returning({ id: companies.id });
    testCompanyId = c!.id;
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("criterion 1: only an administrator can call the block route", async () => {
    const adminApp = createApp(db, admin);
    const created = await request(adminApp)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "alice-auth", name: "Alice", password: PASSWORD, role: "member" });
    expect(created.status).toBe(201);
    const targetUserId = created.body.id;

    // Anonymous is rejected with 401 Unauthorized
    const anonApp = createApp(db, anonymous);
    const anonRes = await request(anonApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "Policy violation" });
    expect(anonRes.status).toBe(401);

    // Regular member is rejected with 403 Forbidden
    const memberApp = createApp(db, member);
    const memberRes = await request(memberApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "Policy violation" });
    expect(memberRes.status).toBe(403);

    // Agent is rejected with 403 Forbidden
    const agentApp = createApp(db, agent);
    const agentRes = await request(agentApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "Policy violation" });
    expect(agentRes.status).toBe(403);

    // Instance administrator is allowed
    const adminRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "Confirmed spammer account" });
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.ok).toBe(true);
    expect(adminRes.body.blocked).toBe(true);
    expect(adminRes.body.reason).toBe("Confirmed spammer account");
  });

  it("criterion 2: empty reason is rejected with 4xx", async () => {
    const adminApp = createApp(db, admin);
    const created = await request(adminApp)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "bob-reason", name: "Bob", password: PASSWORD, role: "member" });
    expect(created.status).toBe(201);
    const targetUserId = created.body.id;

    // Missing reason -> 400
    const missingRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({});
    expect(missingRes.status).toBe(400);

    // Empty string reason -> 400
    const emptyRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "" });
    expect(emptyRes.status).toBe(400);

    // Whitespace-only reason -> 400
    const whitespaceRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "    " });
    expect(whitespaceRes.status).toBe(400);
  });

  it("criterion 3: blocked user loses access and active keys are revoked", async () => {
    const adminApp = createApp(db, admin);
    const created = await request(adminApp)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "charlie-access", name: "Charlie", password: PASSWORD, role: "instance_admin" });
    expect(created.status).toBe(201);
    const targetUserId = created.body.id;

    // Issue a board API key for this user
    const token = createBoardApiToken();
    await db.insert(boardApiKeys).values({
      userId: targetUserId,
      name: "charlie key",
      keyHash: hashBearerToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    // Verify key works before blocking
    const keyApp = express();
    keyApp.use(express.json());
    keyApp.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null } as never));
    keyApp.use("/api", usersAdminRoutes(db, { authPublicBaseUrl: BASE }));
    keyApp.use(errorHandler);
    const callWithKey = () => request(keyApp).get("/api/myrmidon/users-admin-a/users").set("authorization", `Bearer ${token}`);
    expect((await callWithKey()).status).toBe(200);

    // Admin blocks user via dedicated block operator
    const blockRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: "Security incident: credential leak" });
    expect(blockRes.status).toBe(200);
    expect(blockRes.body.blocked).toBe(true);
    expect(blockRes.body.sessionsClosed).toBeGreaterThanOrEqual(0);

    // User is in userBlocks table
    const blocks = await db.select().from(userBlocks).where(eq(userBlocks.userId, targetUserId));
    expect(blocks.length).toBe(1);

    // User's active board API keys are revoked
    const keys = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, targetUserId));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.revokedAt !== null)).toBe(true);

    // Key access fails with 401
    expect((await callWithKey()).status).toBe(401);
  });

  it("criterion 4: audit record contains actor, target, and reason", async () => {
    const adminApp = createApp(db, admin);
    const created = await request(adminApp)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "david-audit", name: "David Audit", password: PASSWORD, role: "member" });
    expect(created.status).toBe(201);
    const targetUserId = created.body.id;

    const blockReason = "Terms of service violation (OPE-10215 test)";
    const blockRes = await request(adminApp)
      .post(`/api/users/${targetUserId}/block`)
      .send({ reason: blockReason });
    expect(blockRes.status).toBe(200);

    // Non-admin cannot view audit records
    const memberApp = createApp(db, member);
    const deniedAudit = await request(memberApp).get("/api/audit");
    expect(deniedAudit.status).toBe(403);

    // Admin queries audit log
    const auditRes = await request(adminApp).get(`/api/users/${targetUserId}/audit`);
    expect(auditRes.status).toBe(200);
    const items = Array.isArray(auditRes.body) ? auditRes.body : auditRes.body.items;
    expect(Array.isArray(items)).toBe(true);

    const auditEntry = items.find(
      (item: { targetUserId?: string; target?: string }) =>
        item.targetUserId === targetUserId || item.target === targetUserId,
    );
    expect(auditEntry).toBeDefined();

    // Verify actor
    expect(auditEntry.actor).toBe(admin.userId);
    expect(auditEntry.actorId).toBe(admin.userId);

    // Verify target
    expect(auditEntry.target).toBe(targetUserId);
    expect(auditEntry.targetUserId).toBe(targetUserId);

    // Verify reason
    expect(auditEntry.reason).toBe(blockReason);
    expect(auditEntry.details.reason).toBe(blockReason);
  });
});
