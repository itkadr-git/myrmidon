/**
 * myrmidon 1.7 USERS-ADMIN-INVITE (OPE-12090): HTTP tests for
 * POST /api/users/invite — DTO validation of email/role and invite creation
 * without SMTP. A valid pair creates an invite row and returns the raw token
 * once; an invalid email or an unknown role is rejected with 400.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, invites } from "@myrmidon/db";
import { errorHandler } from "../middleware/error-handler.js";
import { usersRoutes } from "../routes/users.js";
import { accessRoutes } from "../routes/access.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const admin: Actor = {
  type: "board",
  userId: "admin-user",
  source: "local_implicit",
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
  app.use("/api", usersRoutes(db));
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describePostgres("POST /api/users/invite (OPE-12090)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-users-invite-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ name: "Invite Test Company", issuePrefix: "INV" });
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates an invite for a valid email/role pair and returns the token once", async () => {
    const app = createApp(db, admin);
    const res = await request(app)
      .post("/api/users/invite")
      .send({ email: "New.User@Example.com", role: "member" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.email).toBe("New.User@Example.com");
    expect(res.body.role).toBe("member");
    expect(res.body.token).toMatch(/^pcp_invite_/);
    expect(res.body.inviteUrl).toBe(`/invite/${res.body.token}`);
    expect(res.body.expiresAt).toBeTruthy();

    const rows = await db
      .select()
      .from(invites)
      .where(eq(invites.id, res.body.inviteId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(res.body.token);
    expect(rows[0]!.inviteType).toBe("user_invite");
    expect(rows[0]!.companyId).toBeNull();
    expect(rows[0]!.defaultsPayload).toMatchObject({
      invitedEmail: "New.User@Example.com",
      invitedRole: "member",
    });
  });

  it("defaults the role to member when omitted", async () => {
    const app = createApp(db, admin);
    const res = await request(app)
      .post("/api/users/invite")
      .send({ email: "role-default@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("member");
  });

  it("accepts instance_admin as a role", async () => {
    const app = createApp(db, admin);
    const res = await request(app)
      .post("/api/users/invite")
      .send({ email: "future-admin@example.com", role: "instance_admin" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("instance_admin");
  });

  it("rejects an invalid email with 400", async () => {
    const app = createApp(db, admin);
    for (const bad of ["not-an-email", "missing-at.example.com", "@no-local.com", 42]) {
      const res = await request(app)
        .post("/api/users/invite")
        .send({ email: bad, role: "member" });
      expect(res.status, `email=${String(bad)}`).toBe(400);
    }
  });

  it("rejects an unknown role with 400", async () => {
    const app = createApp(db, admin);
    for (const bad of ["superadmin", "owner", "root", 7]) {
      const res = await request(app)
        .post("/api/users/invite")
        .send({ email: "role-check@example.com", role: bad });
      expect(res.status, `role=${String(bad)}`).toBe(400);
    }
  });

  it("rejects a body with extra keys (strict DTO)", async () => {
    const app = createApp(db, admin);
    const res = await request(app)
      .post("/api/users/invite")
      .send({ email: "strict@example.com", role: "member", message: "hi" });
    expect(res.status).toBe(400);
  });

  it("answers 401/403 to a non-admin caller and creates nothing", async () => {
    for (const [actor, expected] of [
      [anonymous, 401],
      [member, 403],
      [agent, 403],
    ] as const) {
      const app = createApp(db, actor);
      const res = await request(app)
        .post("/api/users/invite")
        .send({ email: "forbidden@example.com", role: "member" });
      expect(res.status).toBe(expected);
    }
    const rows = await db
      .select({ id: invites.id })
      .from(invites)
      .where(eq(invites.inviteType, "user_invite"));
    // Only the three invites created by the admin tests above exist.
    expect(rows).toHaveLength(3);
  });

  it("created user_invite is consumable through the canonical invite summary path", async () => {
    const app = createApp(db, admin);
    const created = await request(app)
      .post("/api/users/invite")
      .send({ email: "consumable@example.com", role: "member" });
    expect(created.status).toBe(201);

    // Anonymous fetch via the shared access contract: the invite summary
    // endpoint must recognize the canonical user_invite type and expose it
    // without a company scope.
    const anonApp = createApp(db, anonymous);
    const summary = await request(anonApp).get(`/api/invites/${created.body.token}`);
    expect(summary.status).toBe(200);
    expect(summary.body.inviteType).toBe("user_invite");
    expect(summary.body.invitePath).toBe(`/invite/${created.body.token}`);
    expect(String(summary.body.inviteUrl)).toContain(`/invite/${created.body.token}`);
  });

  it("instance admin can revoke a user_invite without company scope", async () => {
    const app = createApp(db, admin);
    const created = await request(app)
      .post("/api/users/invite")
      .send({ email: "revocable@example.com", role: "member" });
    expect(created.status).toBe(201);

    const revoked = await request(app)
      .post(`/api/invites/${created.body.inviteId}/revoke`)
      .send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).toBeTruthy();

    // A non-admin cannot revoke another user_invite.
    const created2 = await request(app)
      .post("/api/users/invite")
      .send({ email: "revocable-2@example.com", role: "member" });
    expect(created2.status).toBe(201);
    const memberApp = createApp(db, member);
    const denied = await request(memberApp)
      .post(`/api/invites/${created2.body.inviteId}/revoke`)
      .send({});
    expect(denied.status).toBe(403);
  });
});
