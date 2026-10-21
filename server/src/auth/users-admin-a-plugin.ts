// server/src/auth/users-admin-a-plugin.ts
//
// myrmidon(1.7 USERS-ADMIN-UI A): the Better Auth half of admin-managed users.
//
// Three behaviors, all live-read per request (no restart):
//
// 1. Self-registration gate. `POST /sign-up/email` is refused with 403 unless
//    the instance explicitly enables it (`general.authSelfSignUp`, env as the
//    forced override). Implemented as a `hooks.before` middleware on the
//    sign-up path so the vendor's own error shapes stay authoritative when the
//    classic config `disableSignUp` is on.
//
// 2. Blocked users. A blocked user (`general.myrmidonAuthBlockedUsers`)
//    cannot get a new session: the check runs as a `session.create.before`
//    database hook (covers email, username, handoff and any future sign-in
//    path) AND inside the username endpoint for the clearer error before
//    password work. Existing sessions are closed by the admin route at block
//    time (deleted from the `session` table directly).
//
// 3. Username sign-in. `POST /sign-in/username` accepts the login the admin
//    created a user with. The username plugin stores users by a real
//    `username` column; this module resolves the admin-created login through
//    the synthetic address namespace (`login@myr.local`) first and falls back
//    to the username column, then verifies the credential through the
//    internalAdapter exactly like the vendor's username plugin does. Users
//    with a real email keep signing in by email exactly as before.
//
// The plugin takes a `readGeneral` seam so tests inject an in-memory settings
// row; production passes the real instance settings reader.

import { eq } from "drizzle-orm";
import { setSessionCookie } from "better-auth/cookies";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { APIError, type BetterAuthPlugin } from "better-auth";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import {
  AUTH_SELF_SIGN_UP_SETTINGS_KEY,
  noEmailSyntheticAddress,
  resolveAuthSelfSignUp,
} from "@paperclipai/shared";
import { isUserBlocked } from "../myrmidon/users-admin-a/store.js";

/** The shape of the settings seam the plugin needs. */
export type UsersAdminAuthGeneral = () => Promise<unknown>;

export interface UsersAdminAuthPluginDeps {
  db: Db;
  /** Reads the raw `instance_settings.general` row value. */
  readGeneral: UsersAdminAuthGeneral;
  env?: Record<string, string | undefined>;
}

const BLOCKED_SIGN_IN_MESSAGE = "This account is blocked";

async function isBlocked(deps: UsersAdminAuthPluginDeps, userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  try {
    const general = await deps.readGeneral();
    return isUserBlocked(general, userId);
  } catch {
    // A settings read failure must not lock out every user of the instance.
    return false;
  }
}

async function selfSignUpAllowed(deps: UsersAdminAuthPluginDeps): Promise<boolean> {
  try {
    const general = (await deps.readGeneral()) as Record<string, unknown> | null;
    return resolveAuthSelfSignUp({
      stored:
        general && typeof general === "object" ? general[AUTH_SELF_SIGN_UP_SETTINGS_KEY] : undefined,
      env: deps.env,
    }).enabled;
  } catch {
    return false;
  }
}

export function usersAdminAuthPlugin(deps: UsersAdminAuthPluginDeps): BetterAuthPlugin {
  return {
    id: "myrmidon-users-admin-a",
    // databaseHooks ride the init-options path, the way the vendor's
    // last-login-method plugin injects them (BetterAuthPlugin itself has no
    // databaseHooks field; they merge into the top-level options).
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                async before(session) {
                  const blocked = await isBlocked(deps, session.userId);
                  if (blocked) {
                    throw new APIError("FORBIDDEN", {
                      code: "USER_BLOCKED",
                      message: BLOCKED_SIGN_IN_MESSAGE,
                    });
                  }
                  return;
                },
              },
            },
          },
        },
      };
    },
    hooks: {
      before: [
        {
          matcher(context) {
            return context.path === "/sign-up/email";
          },
          handler: createAuthMiddleware(async () => {
            const allowed = await selfSignUpAllowed(deps);
            if (allowed) return;
            throw new APIError("FORBIDDEN", {
              code: "SELF_SIGN_UP_DISABLED",
              message:
                "Self-registration is disabled on this instance. Ask an administrator to create your account.",
            });
          }),
        },
      ],
    },
    endpoints: {
      signInUsername: createAuthEndpoint(
        "/sign-in/username",
        {
          method: "POST",
          // The body is validated inside the handler: username and password
          // are strings of at least one char; everything else follows the
          // vendor's sign-in semantics (rememberMe, callbackURL).
          metadata: {
            openapi: {
              summary: "Sign in with username (myrmidon USERS-ADMIN-UI A)",
              description:
                "Sign in with the username an administrator created the account with. Resolves the no-email synthetic address, falls back to the username column, then verifies the credential like the vendor username plugin.",
            },
          },
        },
        async (ctx) => {
          const body = ctx.body as {
            username?: unknown;
            password?: unknown;
            rememberMe?: unknown;
            callbackURL?: unknown;
          };
          if (
            typeof body?.username !== "string" ||
            typeof body?.password !== "string" ||
            !body.username ||
            !body.password
          ) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            });
          }
          const address = noEmailSyntheticAddress(body.username);
          const user = await deps.db
            .select({
              id: authUsers.id,
              email: authUsers.email,
              emailVerified: authUsers.emailVerified,
            })
            .from(authUsers)
            .where(eq(authUsers.email, address))
            .then((rows) => rows[0] ?? null);
          if (!user) {
            // Constant-ish work against enumeration: hash the offered password.
            await ctx.context.password.hash(body.password);
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            });
          }
          // Blocked users are also rejected by the session.create.before hook;
          // this early check gives the clearer error before password work.
          if (await isBlocked(deps, user.id)) {
            throw new APIError("FORBIDDEN", {
              code: "USER_BLOCKED",
              message: BLOCKED_SIGN_IN_MESSAGE,
            });
          }
          const account = await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (!account) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            });
          }
          const currentPassword = (account as { password?: string | null }).password ?? null;
          if (!currentPassword) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            });
          }
          const valid = await ctx.context.password.verify({
            hash: currentPassword,
            password: body.password,
          });
          if (!valid) {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_USERNAME_OR_PASSWORD",
              message: "Invalid username or password",
            });
          }
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            body.rememberMe === false,
          );
          if (!session) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Failed to create session",
            });
          }
          const fullUser = await ctx.context.internalAdapter.findUserById(user.id);
          await setSessionCookie(
            ctx as never,
            {
              session,
              user: fullUser ?? {
                id: user.id,
                name: body.username,
                email: user.email,
                emailVerified: Boolean(user.emailVerified),
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
            body.rememberMe === false,
          );
          if (typeof body.callbackURL === "string" && body.callbackURL) {
            ctx.setHeader("Location", body.callbackURL);
          }
          return ctx.json({
            redirect: typeof body.callbackURL === "string" && Boolean(body.callbackURL),
            token: session.token,
            url: typeof body.callbackURL === "string" ? body.callbackURL : null,
            user: { id: user.id, email: user.email, username: body.username },
          });
        },
      ),
    },
  };
}
