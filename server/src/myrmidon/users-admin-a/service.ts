// myrmidon(OPE-8985): create, block and reset the password of board users on
// behalf of an instance administrator, plus the one-time password-set link.
//
// Users are written in the shape Better Auth's own email/password sign-up
// writes them (`user` + credential `account`), so sign-in keeps going through
// the vendor path. A user created by an administrator has no mailbox: the
// address is the synthetic `<login>@myr.local`, and the login form takes it
// like any other email.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  instanceUserRoles,
  userBlocks,
  userPasswordSetTokens,
} from "@paperclipai/db";

export const CREDENTIAL_ISSUER = "local:credential";
export const MANAGED_EMAIL_DOMAIN = "myr.local";
export const PASSWORD_SET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$/;

export type ManagedRole = "instance_admin" | "member";

export interface ManagedUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: ManagedRole;
  blocked: boolean;
  syntheticEmail: boolean;
  createdAt: string;
}

export class UsersAdminError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function hashPasswordSetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function emailToUsername(email: string): string {
  return email.split("@")[0] ?? email;
}

function toManagedUser(
  row: { id: string; name: string; email: string; createdAt: Date },
  admins: Set<string>,
  blocked: Set<string>,
): ManagedUser {
  return {
    id: row.id,
    username: emailToUsername(row.email),
    email: row.email,
    name: row.name,
    role: admins.has(row.id) ? "instance_admin" : "member",
    blocked: blocked.has(row.id),
    syntheticEmail: row.email.endsWith(`@${MANAGED_EMAIL_DOMAIN}`),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listUsers(db: Db): Promise<ManagedUser[]> {
  const rows = await db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, createdAt: authUsers.createdAt })
    .from(authUsers);
  const admins = new Set(
    (await db.select({ userId: instanceUserRoles.userId }).from(instanceUserRoles).where(eq(instanceUserRoles.role, "instance_admin")))
      .map((r) => r.userId),
  );
  const blocked = new Set((await db.select({ userId: userBlocks.userId }).from(userBlocks)).map((r) => r.userId));
  return rows
    .map((row) => toManagedUser(row, admins, blocked))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function getUser(db: Db, userId: string) {
  const row = await db
    .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email, createdAt: authUsers.createdAt })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw new UsersAdminError(404, "NOT_FOUND", "User not found");
  return row;
}

function assertPassword(password: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new UsersAdminError(422, "INVALID_PASSWORD", `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  }
}

async function issueToken(
  db: Pick<Db, "insert">,
  input: { userId: string; via: "create" | "reset"; actorUserId: string; now: Date },
): Promise<string> {
  const token = newToken();
  await db.insert(userPasswordSetTokens).values({
    tokenHash: hashPasswordSetToken(token),
    userId: input.userId,
    issuedVia: input.via,
    issuedByUserId: input.actorUserId,
    createdAt: input.now,
    expiresAt: new Date(input.now.getTime() + PASSWORD_SET_TOKEN_TTL_MS),
  });
  return token;
}

/**
 * Creates a user. With a password the account is usable at once; without one the
 * result carries the raw one-time `token` (the caller turns it into a link).
 */
export async function createUser(
  db: Db,
  input: { username: string; name: string; password?: string | null; role: ManagedRole; actorUserId: string },
): Promise<{ user: ManagedUser; token: string | null }> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new UsersAdminError(422, "INVALID_USERNAME", "Username must be 3-32 chars: lowercase letters, digits, dots, dashes or underscores");
  }
  const password = input.password ? input.password : null;
  if (password) assertPassword(password);
  const email = `${username}@${MANAGED_EMAIL_DOMAIN}`;
  const taken = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).then((r) => r[0] ?? null);
  if (taken) throw new UsersAdminError(409, "CONFLICT", `Username "${username}" is already taken`);

  const now = new Date();
  const userId = randomUUID();
  const passwordHash = password ? await hashPassword(password) : null;
  let token: string | null = null;
  await db.transaction(async (tx) => {
    await tx.insert(authUsers).values({
      id: userId, name: input.name.trim() || username, email, emailVerified: true, createdAt: now, updatedAt: now,
    });
    await tx.insert(authAccounts).values({
      id: randomUUID(), issuer: CREDENTIAL_ISSUER, accountId: userId, providerId: "credential",
      userId, password: passwordHash, createdAt: now, updatedAt: now,
    });
    if (input.role === "instance_admin") {
      await tx.insert(instanceUserRoles).values({ userId, role: "instance_admin" }).onConflictDoNothing();
    }
    if (!password) token = await issueToken(tx, { userId, via: "create", actorUserId: input.actorUserId, now });
  });
  const row = await getUser(db, userId);
  const admins = new Set(input.role === "instance_admin" ? [userId] : []);
  return { user: toManagedUser(row, admins, new Set()), token };
}

/** Blocks or unblocks a user; blocking closes every live session. */
export async function setUserBlocked(
  db: Db,
  input: { userId: string; blocked: boolean; actorUserId: string },
): Promise<{ sessionsClosed: number }> {
  await getUser(db, input.userId);
  if (input.blocked && input.userId === input.actorUserId) {
    throw new UsersAdminError(409, "CONFLICT", "You cannot block yourself");
  }
  if (!input.blocked) {
    await db.delete(userBlocks).where(eq(userBlocks.userId, input.userId));
    return { sessionsClosed: 0 };
  }
  await db
    .insert(userBlocks)
    .values({ userId: input.userId, blockedByUserId: input.actorUserId })
    .onConflictDoNothing();
  // Board API keys are a second way in besides sessions: revoke them too. They stay
  // revoked after unblocking; the user issues a new key.
  await db
    .update(boardApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(boardApiKeys.userId, input.userId), isNull(boardApiKeys.revokedAt)));
  const closed = await db.delete(authSessions).where(eq(authSessions.userId, input.userId)).returning({ id: authSessions.id });
  return { sessionsClosed: closed.length };
}

export async function isUserBlocked(db: Pick<Db, "select">, userId: string): Promise<boolean> {
  const row = await db.select({ userId: userBlocks.userId }).from(userBlocks).where(eq(userBlocks.userId, userId)).then((r) => r[0] ?? null);
  return row !== null;
}

/** Revokes older live links of the user and returns a fresh raw token. */
export async function resetUserPassword(db: Db, input: { userId: string; actorUserId: string }): Promise<{ token: string }> {
  await getUser(db, input.userId);
  const now = new Date();
  return db.transaction(async (tx) => {
    await tx
      .update(userPasswordSetTokens)
      .set({ revokedAt: now, revokedReason: "superseded" })
      .where(and(eq(userPasswordSetTokens.userId, input.userId), isNull(userPasswordSetTokens.revokedAt)));
    return { token: await issueToken(tx, { userId: input.userId, via: "reset", actorUserId: input.actorUserId, now }) };
  });
}

/**
 * Consumes a link token exactly once. The claim is a single UPDATE ... WHERE
 * revoked_at IS NULL AND expires_at > now, so a replay or a race finds nothing.
 * Unknown, used and expired tokens answer the same 404: a probe learns nothing.
 */
export async function consumePasswordSetToken(db: Db, input: { token: string; newPassword: string }): Promise<{ userId: string }> {
  assertPassword(input.newPassword);
  const now = new Date();
  const hash = await hashPassword(input.newPassword);
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(userPasswordSetTokens)
      .set({ revokedAt: now, revokedReason: "used" })
      .where(and(
        eq(userPasswordSetTokens.tokenHash, hashPasswordSetToken(input.token)),
        isNull(userPasswordSetTokens.revokedAt),
        gt(userPasswordSetTokens.expiresAt, now),
      ))
      .returning({ userId: userPasswordSetTokens.userId })
      .then((rows) => rows[0] ?? null);
    if (!claimed) throw new UsersAdminError(404, "LINK_INVALID", "The password link is invalid, used or expired");
    const updated = await tx
      .update(authAccounts)
      .set({ password: hash, updatedAt: now })
      .where(and(eq(authAccounts.userId, claimed.userId), eq(authAccounts.providerId, "credential")))
      .returning({ id: authAccounts.id });
    if (updated.length === 0) {
      await tx.insert(authAccounts).values({
        id: randomUUID(), issuer: CREDENTIAL_ISSUER, accountId: claimed.userId, providerId: "credential",
        userId: claimed.userId, password: hash, createdAt: now, updatedAt: now,
      });
    }
    // A new password ends every session opened with the old one.
    await tx.delete(authSessions).where(eq(authSessions.userId, claimed.userId));
    return { userId: claimed.userId };
  });
}
