/**
 * myrmidon(OPE-8985): HTTP tests of /api/myrmidon/users-admin-a/* against a
 * migrated embedded Postgres, plus sign-in through the real Better Auth mount
 * for the "created user logs in / blocked user does not" half.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { authSessions, authUsers, boardApiKeys, createDb, userPasswordSetTokens } from "@myrmidon/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createBoardApiToken, hashBearerToken } from "../services/board-auth.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { errorHandler } from "../middleware/index.js";
import { usersAdminRoutes } from "../myrmidon/users-admin-a/routes.js";
import { hashPasswordSetToken } from "../myrmidon/users-admin-a/service.js";
import type { Config } from "../config.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

const ORIGIN = "http://127.0.0.1:41998";
const BASE = "https://board.example.test";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "another-long-password-42";
type Db = ReturnType<typeof createDb>;
type Actor = Express.Request["actor"];

const admin: Actor = { type: "board", userId: "admin-user", source: "session", isInstanceAdmin: true, companyIds: [] } as unknown as Actor;
const member: Actor = { type: "board", userId: "member-user", source: "session", isInstanceAdmin: false, companyIds: [] } as unknown as Actor;
const agent: Actor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" } as unknown as Actor;
const anonymous: Actor = { type: "none", source: "none" } as unknown as Actor;

function appFor(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", usersAdminRoutes(db, { authPublicBaseUrl: BASE }));
  app.use(errorHandler);
  return app;
}

function tokenOf(link: string): string {
  const match = /\/password-set\/([^/?#]+)$/.exec(link);
  expect(match, `link shape: ${link}`).not.toBeNull();
  return decodeURIComponent(match![1]!);
}

describePostgres("users-admin-a routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let authApp!: express.Express;
  const envSecret = process.env.BETTER_AUTH_SECRET;
  const envRate = process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-users-admin-a-routes";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-users-admin-routes-");
    db = createDb(tempDb.connectionString);
    const config = {
      deploymentMode: "authenticated", deploymentExposure: "private", authBaseUrlMode: "explicit",
      authPublicBaseUrl: ORIGIN, authDisableSignUp: false, allowedHostnames: ["127.0.0.1"], port: 41998,
    } as unknown as Config;
    authApp = express();
    authApp.all("/api/auth/{*authPath}", createBetterAuthHandler(createBetterAuthInstance(db, config, [ORIGIN])));
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (envSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = envSecret;
    if (envRate === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED; else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = envRate;
  });

  const signIn = (email: string, password: string) =>
    request(authApp).post("/api/auth/sign-in/email").set("origin", ORIGIN).send({ email, password });

  it("answers 403 to a non-admin, an agent token and an anonymous caller on every admin route", async () => {
    for (const actor of [member, anonymous, agent]) {
      const app = appFor(db, actor);
      expect((await request(app).get("/api/myrmidon/users-admin-a/users")).status).toBe(403);
      expect((await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "nope-user", name: "N" })).status).toBe(403);
      expect((await request(app).patch("/api/myrmidon/users-admin-a/users/x").send({ blocked: true })).status).toBe(403);
    }
  });

  it("creates a user with a temporary password; the user signs in and is listed", async () => {
    const app = appFor(db, admin);
    const created = await request(app)
      .post("/api/myrmidon/users-admin-a/users")
      .send({ username: "Alice.Ops", name: "Alice", password: PASSWORD, role: "member" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ username: "alice.ops", name: "Alice", role: "member", blocked: false, syntheticEmail: true, email: "alice.ops@myr.local", passwordSetLink: null });

    expect((await signIn("alice.ops@myr.local", PASSWORD)).status).toBe(200);

    const list = await request(app).get("/api/myrmidon/users-admin-a/users");
    expect(list.status).toBe(200);
    expect(list.body.users.find((u: { id: string }) => u.id === created.body.id)).toMatchObject({ username: "alice.ops", role: "member", blocked: false });
  });

  it("creates an instance admin, rejects a duplicate login and a short password", async () => {
    const app = appFor(db, admin);
    const root = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "root-two", name: "Root", password: PASSWORD, role: "instance_admin" });
    expect(root.status).toBe(201);
    expect(root.body.role).toBe("instance_admin");
    expect((await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "root-two", name: "Again" })).status).toBe(409);
    expect((await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "short-pass", name: "S", password: "abc" })).status).toBe(422);
    expect((await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "x", name: "S" })).status).toBe(422);
  });

  it("blocks a user: sessions closed, sign-in refused; unblock restores access", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "bob-block", name: "Bob", password: PASSWORD });
    expect((await signIn("bob-block@myr.local", PASSWORD)).status).toBe(200);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, created.body.id))).toHaveLength(1);

    const blocked = await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ blocked: true });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ blocked: true, sessionsClosed: 1 });
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, created.body.id))).toHaveLength(0);
    expect((await signIn("bob-block@myr.local", PASSWORD)).status).toBe(403);
    const list = await request(app).get("/api/myrmidon/users-admin-a/users");
    expect(list.body.users.find((u: { id: string }) => u.id === created.body.id).blocked).toBe(true);

    expect((await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ blocked: false })).status).toBe(200);
    expect((await signIn("bob-block@myr.local", PASSWORD)).status).toBe(200);
  });

  it("refuses to block yourself and answers 404 for an unknown user and 400 for an empty patch", async () => {
    const app = appFor(db, admin);
    const self = await db.select({ id: authUsers.id }).from(authUsers).limit(1);
    const selfApp = appFor(db, { ...(admin as object), userId: self[0]!.id } as unknown as Actor);
    expect((await request(selfApp).patch(`/api/myrmidon/users-admin-a/users/${self[0]!.id}`).send({ blocked: true })).status).toBe(409);
    expect((await request(app).patch("/api/myrmidon/users-admin-a/users/no-such-user").send({ blocked: true })).status).toBe(404);
    expect((await request(app).patch("/api/myrmidon/users-admin-a/users/no-such-user").send({})).status).toBe(400);
  });

  it("reset returns a one-time link; the user sets a password by it and signs in; the old password stops working", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "carol-reset", name: "Carol", password: PASSWORD });
    const reset = await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ resetPassword: true });
    expect(reset.status).toBe(200);
    expect(reset.body.passwordSetLink).toMatch(new RegExp(`^${BASE}/password-set/`));
    const token = tokenOf(reset.body.passwordSetLink);

    // Only the hash is stored.
    const rows = await db.select().from(userPasswordSetTokens).where(eq(userPasswordSetTokens.userId, created.body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashPasswordSetToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);

    // The public route needs no actor.
    const anon = appFor(db, anonymous);
    const set = await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token, newPassword: NEW_PASSWORD });
    expect(set.status).toBe(200);
    expect((await signIn("carol-reset@myr.local", NEW_PASSWORD)).status).toBe(200);
    expect((await signIn("carol-reset@myr.local", PASSWORD)).status).not.toBe(200);
  });

  it("creates a user without a password: the link sets the first password", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "dave-link", name: "Dave" });
    expect(created.status).toBe(201);
    const token = tokenOf(created.body.passwordSetLink);
    expect((await signIn("dave-link@myr.local", NEW_PASSWORD)).status).not.toBe(200);
    expect((await request(appFor(db, anonymous)).post("/api/myrmidon/users-admin-a/password-set").send({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await signIn("dave-link@myr.local", NEW_PASSWORD)).status).toBe(200);
  });

  it("a link works once: the second use is refused", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "erin-once", name: "Erin" });
    const token = tokenOf(created.body.passwordSetLink);
    const anon = appFor(db, anonymous);
    expect((await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    const replay = await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token, newPassword: "attacker-password-1" });
    expect(replay.status).toBe(404);
    expect((await signIn("erin-once@myr.local", "attacker-password-1")).status).not.toBe(200);
    expect((await signIn("erin-once@myr.local", NEW_PASSWORD)).status).toBe(200);
  });

  it("an expired link is refused and does not change the password", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "frank-late", name: "Frank", password: PASSWORD });
    const reset = await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ resetPassword: true });
    const token = tokenOf(reset.body.passwordSetLink);
    await db.update(userPasswordSetTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userPasswordSetTokens.userId, created.body.id));
    const late = await request(appFor(db, anonymous)).post("/api/myrmidon/users-admin-a/password-set").send({ token, newPassword: NEW_PASSWORD });
    expect(late.status).toBe(404);
    expect((await signIn("frank-late@myr.local", PASSWORD)).status).toBe(200);
  });

  it("a newer reset supersedes the older link; an unknown token is refused", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "gina-two", name: "Gina", password: PASSWORD });
    const first = tokenOf((await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ resetPassword: true })).body.passwordSetLink);
    const second = tokenOf((await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ resetPassword: true })).body.passwordSetLink);
    const anon = appFor(db, anonymous);
    expect((await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token: first, newPassword: NEW_PASSWORD })).status).toBe(404);
    expect((await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token: "x".repeat(43), newPassword: NEW_PASSWORD })).status).toBe(404);
    expect((await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token: second, newPassword: "short" })).status).toBe(400);
    expect((await request(anon).post("/api/myrmidon/users-admin-a/password-set").send({ token: second, newPassword: NEW_PASSWORD })).status).toBe(200);
  });

  it("a board API key of a blocked user is rejected and revoked; unblocking does not revive it", async () => {
    const app = appFor(db, admin);
    const created = await request(app).post("/api/myrmidon/users-admin-a/users").send({ username: "ivan-key", name: "Ivan", password: PASSWORD, role: "instance_admin" });
    const issue = async () => {
      const token = createBoardApiToken();
      await db.insert(boardApiKeys).values({
        userId: created.body.id, name: "test key", keyHash: hashBearerToken(token), expiresAt: new Date(Date.now() + 3_600_000),
      });
      return token;
    };
    const keyApp = express();
    keyApp.use(express.json());
    keyApp.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null } as never));
    keyApp.use("/api", usersAdminRoutes(db, { authPublicBaseUrl: BASE }));
    keyApp.use(errorHandler);
    const call = (token: string) => request(keyApp).get("/api/myrmidon/users-admin-a/users").set("authorization", `Bearer ${token}`);

    const first = await issue();
    expect((await call(first)).status).toBe(200);

    expect((await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ blocked: true })).status).toBe(200);
    const rows = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, created.body.id));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await call(first)).status).toBe(401);

    // A key created while the user is blocked is refused too (access check, not only revocation).
    const whileBlocked = await issue();
    expect((await call(whileBlocked)).status).toBe(401);

    // Unblocking: the keys revoked at block time stay dead; the user issues a new one.
    expect((await request(app).patch(`/api/myrmidon/users-admin-a/users/${created.body.id}`).send({ blocked: false })).status).toBe(200);
    expect((await call(first)).status).toBe(401);
    expect((await call(await issue())).status).toBe(200);
  });
});
