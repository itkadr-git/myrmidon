// GET/POST/PATCH /api/myrmidon/users-admin-a/users (myrmidon 1.7 USERS-ADMIN-UI A).
//
// GET lists users with block state and role. POST creates a user (login +
// password, or login + a one-time password-set link, optional role). PATCH
// blocks/unblocks (closing live sessions) and resets the password (a fresh
// one-time link). All mutating routes are instance-admin only; the list is
// board-visible. Every mutation lands in the activity log with who did what.
//
// POST /password-set consumes the one-time token (the user themselves, no
// auth: the token is the proof), and GET/PATCH /self-sign-up read and flip
// the self-registration switch with its value source.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { z } from "zod";
import {
  patchAuthSelfSignUpSettingsSchema,
  normalizeAuthSelfSignUpSettings,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  createUser,
  setUserBlocked,
  resetUserPassword,
  consumePasswordSetToken,
  listUsers,
  UsersAdminError,
  readSelfSignUp,
} from "./service.js";
import { readStoredBlockedUsers } from "./store.js";

const createUserSchema = z
  .object({
    username: z.string().min(1).max(64),
    displayName: z.string().max(120).optional(),
    email: z.string().email().optional().nullable(),
    /** Either a password or a one-time password-set link (omit both = link). */
    password: z.string().min(8).max(128).optional().nullable(),
    role: z.enum(["instance_admin", "member"]).default("member"),
  })
  .strict();

const patchUserSchema = z
  .object({
    blocked: z.boolean().optional(),
    reason: z.string().max(500).optional().nullable(),
    resetPassword: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.blocked !== undefined || v.resetPassword !== undefined, {
    message: "Provide at least one of `blocked` or `resetPassword`",
  });

const passwordSetSchema = z
  .object({
    token: z.string().min(20).max(200),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

function errorResponse(err: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  if (err instanceof UsersAdminError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return true;
  }
  return false;
}

async function auditLogUsers(db: Db, companyId: string, actorUserId: string, entry: { action: string; targetUserId: string; targetEmail: string; detail: Record<string, unknown> }) {
  await logActivity(db, {
    companyId,
    actorType: "user",
    actorId: actorUserId,
    action: entry.action,
    entityType: "user",
    entityId: entry.targetUserId,
    details: { email: entry.targetEmail, ...entry.detail },
  });
}

/** The company ids every instance-level audit entry fans out to. */
async function auditCompanyIds(db: Db): Promise<string[]> {
  return db
    .select({ id: companies.id })
    .from(companies)
    .then((rows) => rows.map((row) => row.id));
}

export function usersAdminRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/users-admin-a/users", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await listUsers(db));
  });

  router.post(
    "/myrmidon/users-admin-a/users",
    validate(createUserSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      try {
        const created = await createUser(db, {
          ...(req.body as z.infer<typeof createUserSchema>),
          actorUserId: actor.actorId,
        });
        for (const companyId of await auditCompanyIds(db)) {
          await auditLogUsers(db, companyId, actor.actorId, {
            action: "instance.user.created",
            targetUserId: created.id,
            targetEmail: created.email,
            detail: {
              username: created.username,
              role: created.role,
              syntheticEmail: created.syntheticEmail,
              passwordMode: created.passwordSetLink ? "set_link" : "direct",
            },
          });
        }
        res.status(201).json(created);
      } catch (err) {
        if (!errorResponse(err, res)) throw err;
      }
    },
  );

  router.patch(
    "/myrmidon/users-admin-a/users/:userId",
    validate(patchUserSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const actor = getActorInfo(req);
      // Route params are single-valued here; the cast keeps this robust across
      // express typings where params values widen to string | string[].
      const userId = String(req.params.userId);
      const body = req.body as z.infer<typeof patchUserSchema>;
      try {
        const result: Record<string, unknown> = { userId };
        if (body.blocked !== undefined) {
          const blocked = await setUserBlocked(db, {
            userId,
            blocked: body.blocked,
            actorUserId: actor.actorId,
            reason: body.reason ?? null,
          });
          result.blocked = body.blocked;
          result.sessionsClosed = blocked.sessionsClosed;
          for (const companyId of await auditCompanyIds(db)) {
            await auditLogUsers(db, companyId, actor.actorId, {
              action: body.blocked ? "instance.user.blocked" : "instance.user.unblocked",
              targetUserId: userId,
              targetEmail: (await listUsers(db)).find((u) => u.id === userId)?.email ?? "",
              detail: { reason: body.reason ?? null, sessionsClosed: blocked.sessionsClosed },
            });
          }
        }
        if (body.resetPassword) {
          const reset = await resetUserPassword(db, { userId, actorUserId: actor.actorId });
          result.passwordSetLink = reset.passwordSetLink;
          for (const companyId of await auditCompanyIds(db)) {
            await auditLogUsers(db, companyId, actor.actorId, {
              action: "instance.user.password_reset",
              targetUserId: userId,
              targetEmail: (await listUsers(db)).find((u) => u.id === userId)?.email ?? "",
              detail: { via: "set_link" },
            });
          }
        }
        res.json(result);
      } catch (err) {
        if (!errorResponse(err, res)) throw err;
      }
    },
  );

  router.post(
    "/myrmidon/users-admin-a/password-set",
    validate(passwordSetSchema),
    async (req, res) => {
      const body = req.body as z.infer<typeof passwordSetSchema>;
      try {
        const { userId } = await consumePasswordSetToken(db, body);
        for (const companyId of await auditCompanyIds(db)) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: userId,
            action: "instance.user.password_set",
            entityType: "user",
            entityId: userId,
            details: { via: "token" },
          });
        }
        res.json({ ok: true });
      } catch (err) {
        if (!errorResponse(err, res)) throw err;
      }
    },
  );

  router.get("/myrmidon/users-admin-a/self-sign-up", async (req, res) => {
    assertBoardOrgAccess(req);
    const general = await settings.getGeneral();
    res.json(readSelfSignUp(general, process.env));
  });

  router.patch(
    "/myrmidon/users-admin-a/self-sign-up",
    validate(patchAuthSelfSignUpSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const general = await settings.getGeneral();
      const current = normalizeAuthSelfSignUpSettings(general.authSelfSignUp);
      const patch = req.body as z.infer<typeof patchAuthSelfSignUpSettingsSchema>;
      const next = { enabled: patch.enabled ?? current?.enabled ?? false };
      await settings.updateGeneral({ authSelfSignUp: next });
      const fresh = await settings.getGeneral();
      res.json(readSelfSignUp(fresh, process.env));
    },
  );

  return router;
}
