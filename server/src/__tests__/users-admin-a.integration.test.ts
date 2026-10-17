/**
 * myrmidon(1.7 USERS-ADMIN-UI A) end-to-end coverage of the admin-managed
 * user lifecycle, driven through the real Better Auth mount and the real
 * users-admin routes against a migrated embedded Postgres.
 *
 * Acceptance criteria of the ticket, each as one test:
 *  1. A user created without an email signs in (username sign-in).
 *  2. A self-registration attempt is refused while the switch is off, and
 *     succeeds only after the instance explicitly enables it.
 *  3. A blocked user cannot sign in, and blocking closes their live sessions.
 *
 * Admin create/block/reset and token consumption are exercised through the
 * mounted HTTP router as well as the real Better Auth sign-in endpoints.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, companyMemberships, companies, createDb, instanceSettings, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { usersAdminRoutes } from "../myrmidon/users-admin-a/routes.js";
import { createUser as usersAdminCreateUser, listUsers as usersAdminListUsers } from "../myrmidon/users-admin-a/service.js";
import { setBlockedUser } from "../myrmidon/users-admin-a/store.js";
import type { Config } from "../config.js";
import { resolveAuthSelfSignUp } from "@paperclipai/shared";
import express from "express";
import request from "supertest";

const ORIGIN = "http://127.0.0.1:41997";
const ADMIN_PASSWORD = "correct-horse-battery-staple";
const USER_PASSWORD = "hunter-wants-42-tacos";
const USER_PASSWORD_2 = "hunter-wants-43-tacos";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41997,
  } as unknown as Config;
}

/** The settings seam the plugin reads: the real singleton row. */
function readGeneralRow(db: ReturnType<typeof createDb>) {
  return async () => {
    const row = await db
      .select({ general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, "default"))
      .then((rows) => rows[0] ?? null);
    return row?.general ?? null;
  };
}

/** The minimal Express mount: only Better Auth, exactly as createApp mounts it. */
function buildAuthApp(db: ReturnType<typeof createDb>, config: Config) {
  const auth = createBetterAuthInstance(db, config, [ORIGIN]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "00000000-0000-0000-0000-000000000001",
      source: "local_implicit",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: true,
    } as unknown as Express.Request["actor"];
    next();
  });
  app.use("/api", usersAdminRoutes(db));
  app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const candidate = err as { status?: number; message?: string };
    res.status(candidate.status ?? 500).json({ error: candidate.message ?? "Internal error" });
  });
  return app;
}

describeEmbeddedPostgres("users-admin-a: admin-managed users", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
    selfSignUp: process.env.MYRMIDON_AUTH_SELF_SIGN_UP,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-users-admin-a-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    delete process.env.MYRMIDON_AUTH_SELF_SIGN_UP;

    database = await startEmbeddedPostgresTestDatabase("paperclip-users-admin-a-");
    db = createDb(database.connectionString);
    app = buildAuthApp(db, testConfig());
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
    if (originalEnv.selfSignUp === undefined) delete process.env.MYRMIDON_AUTH_SELF_SIGN_UP;
    else process.env.MYRMIDON_AUTH_SELF_SIGN_UP = originalEnv.selfSignUp;
  });

  it("creates a user without an email and signs them in by username", async () => {
    const company = await db.insert(companies).values({
      name: "Login test company",
      issuePrefix: `UL${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
    const response = await request(app)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "boardlogin", displayName: "Board Login", password: USER_PASSWORD, role: "member", companyId: company.id, companyRole: "operator" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = response.body;

    expect(created.syntheticEmail).toBe(true);
    expect(created.email).toBe("boardlogin@myr.local");
    expect(created.passwordSetLink).toBeNull();

    // The credential account row exists in the vendor shape.
    const account = await db
      .select()
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, created.id), eq(authAccounts.providerId, "credential")))
      .then((rows) => rows[0] ?? null);
    expect(account).not.toBeNull();
    expect(account?.issuer).toBe("local:credential");

    // Sign-in through the plugin endpoint.
    const signIn = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "boardlogin", password: USER_PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe("boardlogin@myr.local");
    const cookies = String(signIn.headers["set-cookie"] ?? "");
    expect(cookies).toContain("session_token");
  });

  it("rejects user-management writes from a non-admin board actor", async () => {
    const ordinaryApp = express();
    ordinaryApp.use(express.json());
    ordinaryApp.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "00000000-0000-0000-0000-000000000002",
        source: "session",
        sessionId: "nonadmin-session",
        companyIds: [],
        memberships: [],
        isInstanceAdmin: false,
      } as unknown as Express.Request["actor"];
      next();
    });
    ordinaryApp.use("/api", usersAdminRoutes(db));
    const response = await request(ordinaryApp)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "unauthorized-create", role: "instance_admin" });
    expect(response.status).toBe(403);
  });

  it("creates the requested company membership and role grants", async () => {
    const company = await db.insert(companies).values({
      name: "Users admin test company",
      issuePrefix: `UA${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
    const created = await usersAdminCreateUser(db, {
      username: "companyoperator",
      password: USER_PASSWORD,
      role: "member",
      companyId: company.id,
      companyRole: "operator",
      actorUserId: "00000000-0000-0000-0000-000000000001",
    });
    const membership = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, created.id));
    const grants = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, created.id));
    expect(membership).toHaveLength(1);
    expect(membership[0]?.companyId).toBe(company.id);
    expect(membership[0]?.membershipRole).toBe("operator");
    expect(grants.map((grant) => grant.permissionKey)).toContain("tasks:assign");
  });

  it("refuses self-registration while the switch is off, then allows it after the instance enables it", async () => {
    // Default: off. resolveAuthSelfSignUp on an empty row is the source of truth
    // the plugin gate reads.
    const resolved = resolveAuthSelfSignUp({
      stored: (await readGeneralRow(db)()) as Record<string, unknown>,
      env: process.env,
    });
    expect(resolved.enabled).toBe(false);

    const attempt = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "self@myr.example", password: USER_PASSWORD, name: "Self" });
    expect(attempt.status).toBe(403);
    expect(attempt.body?.code).toBe("SELF_SIGN_UP_DISABLED");

    // Explicitly enable through the settings row (the routes path does the
    // same write); the gate reads live, so no restart is simulated at all.
    await db
      .update(instanceSettings)
      .set({ general: { authSelfSignUp: { enabled: true } } })
      .where(eq(instanceSettings.singletonKey, "default"));

    // The row must now carry the enabled switch.
    const generalAfterEnable = await readGeneralRow(db)();
    expect((generalAfterEnable as Record<string, unknown>)?.authSelfSignUp).toEqual({ enabled: true });

    const attempt2 = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "self2@myr.example", password: USER_PASSWORD, name: "Self Two" });
    expect(attempt2.status).toBe(200);
    expect(attempt2.body?.user?.email).toBe("self2@myr.example");

    // Flip back off; the gate must deny again (live read, no restart).
    await db
      .update(instanceSettings)
      .set({ general: {} })
      .where(eq(instanceSettings.singletonKey, "default"));
    const attempt3 = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "self3@myr.example", password: USER_PASSWORD, name: "Self Three" });
    expect(attempt3.status).toBe(403);
  });

  it("blocks a user: closes live sessions and refuses new sign-ins", async () => {
    const company = await db.insert(companies).values({
      name: "Block test company",
      issuePrefix: `UB${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
    const created = await usersAdminCreateUser(db, {
      username: "blockeduser",
      password: USER_PASSWORD,
      role: "member",
      companyId: company.id,
      actorUserId: "00000000-0000-0000-0000-000000000001",
    });

    const signIn = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "blockeduser", password: USER_PASSWORD });
    expect(signIn.status).toBe(200);

    const sessionsBefore = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, created.id));
    expect(sessionsBefore.length).toBeGreaterThan(0);

    const blocked = await request(app)
      .patch(`/api/myrmidon/users-admin-a/users/${created.id}`)
      .send({ blocked: true, reason: "test block" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    expect(blocked.body.sessionsClosed).toBe(sessionsBefore.length);

    // The sessions are gone.
    const sessionsAfter = await db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, created.id));
    expect(sessionsAfter).toHaveLength(0);

    // New sign-ins are refused with the block error.
    const signIn2 = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "blockeduser", password: USER_PASSWORD });
    expect(signIn2.status).toBe(403);
    expect(signIn2.body?.code).toBe("USER_BLOCKED");

    // Unblock restores sign-in.
    const unblocked = await request(app)
      .patch(`/api/myrmidon/users-admin-a/users/${created.id}`)
      .send({ blocked: false });
    expect(unblocked.status).toBe(200);
    const signIn3 = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "blockeduser", password: USER_PASSWORD });
    expect(signIn3.status).toBe(200);
  });

  it("resets the password through a one-time link, and the link dies after use", async () => {
    const company = await db.insert(companies).values({
      name: "Password set test company",
      issuePrefix: `UP${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    }).returning().then((rows) => rows[0]!);
    const created = await usersAdminCreateUser(db, {
      username: "resetuser",
      password: USER_PASSWORD,
      role: "member",
      companyId: company.id,
      actorUserId: "00000000-0000-0000-0000-000000000001",
    });

    const reset = await request(app)
      .patch(`/api/myrmidon/users-admin-a/users/${created.id}`)
      .send({ resetPassword: true });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.passwordSetLink).toMatch(/^\/api\/myrmidon\/password-set\?token=/);

    const token = new URL(reset.body.passwordSetLink, "http://localhost").searchParams.get("token") ?? "";

    // The old password no longer works only after the set; here nothing was
    // changed yet, so the old password still signs in.
    const oldSignIn = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "resetuser", password: USER_PASSWORD });
    expect(oldSignIn.status).toBe(200);

    // Consume the token: set a new password.
    const consumed = await request(app)
      .post("/api/myrmidon/users-admin-a/password-set")
      .send({ token, newPassword: USER_PASSWORD_2 });
    expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);

    // The new password signs in.
    const newSignIn = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "resetuser", password: USER_PASSWORD_2 });
    expect(newSignIn.status).toBe(200);

    // A second use of the same token is dead.
    const replay = await request(app)
      .post("/api/myrmidon/users-admin-a/password-set")
      .send({ token, newPassword: USER_PASSWORD_2 });
    expect(replay.status).toBe(404);

    // The old password no longer signs in.
    const oldSignIn2 = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "resetuser", password: USER_PASSWORD });
    expect(oldSignIn2.status).toBe(401);
  });

  it("creates a user with a one-time password-set link and consumes it over HTTP", async () => {
    const created = await usersAdminCreateUser(db, {
      username: "linkuser",
      role: "member",
      actorUserId: "00000000-0000-0000-0000-000000000001",
    });
    expect(created.passwordSetLink).toMatch(/^\/api\/myrmidon\/password-set\?token=/);

    const user = (await usersAdminListUsers(db)).find((entry) => entry.username === "linkuser");
    const reset = await request(app)
      .patch(`/api/myrmidon/users-admin-a/users/${user!.id}`)
      .send({ resetPassword: true });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const passwordLink = reset.body.passwordSetLink as string;

    const page = await request(app).get(passwordLink);
    expect(page.status).toBe(200);
    expect(page.text).toContain("/api/myrmidon/users-admin-a/password-set");

    const token = new URL(passwordLink, "http://localhost").searchParams.get("token");
    const consumed = await request(app)
      .post("/api/myrmidon/users-admin-a/password-set")
      .send({ token, newPassword: USER_PASSWORD_2 });
    expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);

    const signIn = await request(app)
      .post("/api/auth/sign-in/username")
      .set("origin", ORIGIN)
      .send({ username: "linkuser", password: USER_PASSWORD_2 });
    expect(signIn.status).toBe(200);

    const replay = await request(app)
      .post("/api/myrmidon/users-admin-a/password-set")
      .send({ token, newPassword: USER_PASSWORD_2 });
    expect(replay.status).toBe(404);
  });

  it("grants the instance_admin role and lists users with role and block state", async () => {
    const admin = await usersAdminCreateUser(db, {
      username: "instadmin",
      password: ADMIN_PASSWORD,
      role: "instance_admin",
      actorUserId: "00000000-0000-0000-0000-000000000001",
    });

    const list = await usersAdminListUsers(db);
    const row = list.find((u) => u.id === admin.id);
    expect(row?.role).toBe("instance_admin");
    const member = list.find((u) => u.email === "boardlogin@myr.local");
    expect(member?.role).toBe("member");
    expect(member?.syntheticEmail).toBe(true);
  });
});
