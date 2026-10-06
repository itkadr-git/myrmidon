// server/src/myrmidon/users-admin-a/service.ts
//
// myrmidon(1.7 USERS-ADMIN-UI A): create, block, unblock and reset the password
// of instance users, on behalf of an instance admin.
//
// Creation writes the Better Auth tables directly (`user` + `account` +
// optional `instance_user_roles`), in the exact shape Better Auth's own
// email/password sign-up writes them (credential account with the
// `local:credential` issuer), so sign-in keeps flowing through the vendor's
// verification path instead of a parallel one. A user created without a real
// email gets the synthetic address `login@myr.local` and signs in through
// `POST /api/auth/sign-in/username` (the plugin in
// server/src/auth/users-admin-a-plugin.ts).
//
// Password reset is one of two forms:
//  * `set_link` (default) — a one-time token row in
//    `user_password_set_tokens`, handed to the admin as a URL; the user opens
//    it, picks a password, and the token dies.
//  * `direct` — the admin sets a new password right away; no token row.
//
// Blocking closes the user's live sessions (`session` rows deleted) and the
// sign-in guard refuses new ones. Everything is audit-logged through
// logActivity.

import { randomUUID, randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { hashPassword as hashPasswordBetterAuth, verifyPassword as verifyPasswordBetterAuth } from "better-auth/crypto";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  instanceUserRoles,
  userPasswordSetTokens,
} from "@paperclipai/db";
import {
  NO_EMAIL_DOMAIN,
  noEmailSyntheticAddress,
  AUTH_SELF_SIGN_UP_SETTINGS_KEY,
  AUTH_USERNAME_PATTERN,
  AUTH_USERNAME_MIN,
  AUTH_USERNAME_MAX,
  AUTH_PASSWORD_MIN,
  AUTH_PASSWORD_MAX,
  resolveAuthSelfSignUp,
  type AuthSelfSignUpSource,
} from "@paperclipai/shared";
import { setBlockedUser, readStoredBlockedUsers } from "./store.js";

// The vendor's own password primitives (@better-auth/utils via
// better-auth/crypto): scrypt with the exact parameters Better Auth's
// email/password accounts use, so a password set here verifies on the
// vendor's sign-in path unchanged.
const hashPassword = hashPasswordBetterAuth;
export const verifyPassword = verifyPasswordBetterAuth;

export const CREDENTIAL_ISSUER = "local:credential";
export const PASSWORD_SET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type UserRole = "instance_admin" | "member";

export interface CreateUserData {
  username: string;
  displayName?: string | null;
  email?: string | null;
  password?: string | null;
  role: UserRole;
  actorUserId: string;
}

export interface CreatedUser {
  id: string;
  username: string;
  email: string;
  syntheticEmail: boolean;
  role: UserRole;
  passwordSetLink: string | null;
}

export class UsersAdminError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function conflict(message: string): never {
  throw new UsersAdminError(409, "CONFLICT", message);
}
function notFound(message: string): never {
  throw new UsersAdminError(404, "NOT_FOUND", message);
}

function assertUsername(username: string): void {
  if (
    username.length < AUTH_USERNAME_MIN ||
    username.length > AUTH_USERNAME_MAX ||
    !AUTH_USERNAME_PATTERN.test(username)
  ) {
    throw new UsersAdminError(
      422,
      "INVALID_USERNAME",
      `Username must be ${AUTH_USERNAME_MIN}–${AUTH_USERNAME_MAX} chars of letters, digits, dots or underscores`,
    );
  }
}

function assertPassword(password: string): void {
  if (password.length < AUTH_PASSWORD_MIN || password.length > AUTH_PASSWORD_MAX) {
    throw new UsersAdminError(
      422,
      "INVALID_PASSWORD",
      `Password must be ${AUTH_PASSWORD_MIN}–${AUTH_PASSWORD_MAX} characters`,
    );
  }
}

/** Creates a user with a password or a one-time password-set link. */
export async function createUser(db: Db, input: CreateUserData): Promise<CreatedUser> {
  const username = input.username.trim().toLowerCase();
  assertUsername(username);
  if (input.password !== null && input.password !== undefined) {
    assertPassword(input.password);
  }

  const email = input.email?.trim().toLowerCase() || null;
  const syntheticEmail = email === null;
  const finalEmail = email ?? noEmailSyntheticAddress(username);

  const existingByEmail = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.email, finalEmail))
    .then((rows) => rows[0] ?? null);
  if (existingByEmail) {
    conflict(
      syntheticEmail
        ? `Username "${username}" is already taken`
        : `A user with email "${finalEmail}" already exists`,
    );
  }

  const now = new Date();
  const userId = randomUUID();
  let passwordSetLink: string | null = null;
  let passwordHash: string | null = null;

  await db.transaction(async (tx) => {
    await tx.insert(authUsers).values({
      id: userId,
      name: input.displayName?.trim() || username,
      email: finalEmail,
      emailVerified: !syntheticEmail ? false : true,
      createdAt: now,
      updatedAt: now,
    });

    if (input.password) {
      passwordHash = await hashPassword(input.password);
    } else {
      // One-time password-set token; the sha256 is stored, the raw value is
      // returned once as a link for the admin to hand over.
      const token = randomBytes(32).toString("base64url");
      await tx.insert(userPasswordSetTokens).values({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId,
        issuedVia: "create",
        issuedByUserId: input.actorUserId,
        createdAt: now,
      });
      passwordSetLink = `/api/myrmidon/users-admin-a/password-set?token=${token}`;
    }

    await tx.insert(authAccounts).values({
      id: randomUUID(),
      issuer: CREDENTIAL_ISSUER,
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    if (input.role === "instance_admin") {
      await tx
        .insert(instanceUserRoles)
        .values({ userId, role: "instance_admin" })
        .onConflictDoNothing({ target: [instanceUserRoles.userId, instanceUserRoles.role] });
    }
  });

  return {
    id: userId,
    username,
    email: finalEmail,
    syntheticEmail,
    role: input.role,
    passwordSetLink,
  };
}

/** Blocks or unblocks a user and closes their sessions when blocking. */
export async function setUserBlocked(
  db: Db,
  input: { userId: string; blocked: boolean; actorUserId: string; reason?: string | null },
): Promise<{ sessionsClosed: number }> {
  const user = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, input.userId))
    .then((rows) => rows[0] ?? null);
  if (!user) notFound("User not found");

  if (input.blocked && input.userId === input.actorUserId) {
    conflict("You cannot block yourself");
  }

  await setBlockedUser(db, {
    userId: input.userId,
    blocked: input.blocked,
    blockedBy: input.actorUserId,
    reason: input.reason ?? null,
  });

  let sessionsClosed = 0;
  if (input.blocked) {
    const deleted = await db
      .delete(authSessions)
      .where(eq(authSessions.userId, input.userId))
      .returning({ id: authSessions.id });
    sessionsClosed = deleted.length;
  }
  return { sessionsClosed };
}

/** Issues a fresh one-time password-set link, revoking older live ones. */
export async function resetUserPassword(
  db: Db,
  input: { userId: string; actorUserId: string },
): Promise<{ passwordSetLink: string }> {
  const user = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, input.userId))
    .then((rows) => rows[0] ?? null);
  if (!user) notFound("User not found");

  const now = new Date();
  // Revoke (not delete) outstanding live tokens: the history shows who issued
  // what and when it was superseded.
  await db
    .update(userPasswordSetTokens)
    .set({ revokedAt: now, revokedReason: "superseded" })
    .where(
      and(eq(userPasswordSetTokens.userId, input.userId), isNull(userPasswordSetTokens.revokedAt)),
    );

  const token = randomBytes(32).toString("base64url");
  await db.insert(userPasswordSetTokens).values({
    tokenHash: createHash("sha256").update(token).digest("hex"),
    userId: input.userId,
    issuedVia: "reset",
    issuedByUserId: input.actorUserId,
    createdAt: now,
  });
  return { passwordSetLink: `/api/myrmidon/users-admin-a/password-set?token=${token}` };
}

/** Consumes a one-time password-set token. 404 on unknown/used, 410 on expired. */
export async function consumePasswordSetToken(
  db: Db,
  input: { token: string; newPassword: string },
): Promise<{ userId: string }> {
  assertPassword(input.newPassword);
  const now = new Date();
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  // Mark used (revoked) up front so a raced second use finds nothing live,
  // regardless of the password check outcome below.
  const row = await db
    .update(userPasswordSetTokens)
    .set({ revokedAt: now, revokedReason: "used" })
    .where(
      and(
        eq(userPasswordSetTokens.tokenHash, tokenHash),
        isNull(userPasswordSetTokens.revokedAt),
      ),
    )
    .returning({ userId: userPasswordSetTokens.userId, createdAt: userPasswordSetTokens.createdAt })
    .then((rows) => rows[0] ?? null);
  if (!row) notFound("Unknown or already-used password-set link");
  if (now.getTime() - row.createdAt.getTime() > PASSWORD_SET_TOKEN_TTL_MS) {
    throw new UsersAdminError(410, "TOKEN_EXPIRED", "The password-set link has expired");
  }
  const hash = await hashPassword(input.newPassword);
  await db
    .update(authAccounts)
    .set({ password: hash, updatedAt: now })
    .where(and(eq(authAccounts.userId, row.userId), eq(authAccounts.providerId, "credential")));
  return { userId: row.userId };
}

/** Lists users with their block state and instance role. */
export async function listUsers(
  db: Db,
): Promise<
  Array<{
    id: string;
    name: string;
    email: string;
    syntheticEmail: boolean;
    role: UserRole;
    blocked: boolean;
    blockedAt: string | null;
    blockedBy: string | null;
    createdAt: Date;
  }>
> {
  const blocked = await readStoredBlockedUsers(db);
  const rows = await db
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      createdAt: authUsers.createdAt,
    })
    .from(authUsers);
  const adminRows = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));
  const admins = new Set(adminRows.map((r) => r.userId));
  return rows
    .map((row): {
      id: string;
      name: string;
      email: string;
      syntheticEmail: boolean;
      role: UserRole;
      blocked: boolean;
      blockedAt: string | null;
      blockedBy: string | null;
      createdAt: Date;
    } => {
      const record = blocked[row.id] ?? null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        syntheticEmail: row.email.endsWith(`@${NO_EMAIL_DOMAIN}`),
        role: admins.has(row.id) ? "instance_admin" : "member",
        blocked: Boolean(record),
        blockedAt: record?.blockedAt ?? null,
        blockedBy: record?.blockedBy ?? null,
        createdAt: row.createdAt,
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Reads the self-registration switch with its source (stored/env/default). */
export function readSelfSignUp(general: unknown, env: Record<string, string | undefined> | undefined): {
  enabled: boolean;
  source: AuthSelfSignUpSource;
} {
  const resolved = resolveAuthSelfSignUp({
    stored:
      general && typeof general === "object"
        ? (general as Record<string, unknown>)[AUTH_SELF_SIGN_UP_SETTINGS_KEY]
        : undefined,
    env,
  });
  return { enabled: resolved.enabled, source: resolved.source };
}


