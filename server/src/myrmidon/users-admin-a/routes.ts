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
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";
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
    companyId: z.string().uuid().optional(),
    companyRole: z.enum(["owner", "admin", "operator", "viewer"]).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.role === "member" && !input.companyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["companyId"], message: "companyId is required for company members" });
    }
    if (input.role === "member" && !input.companyRole) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["companyRole"], message: "companyRole is required for company members" });
    }
    if (input.role === "instance_admin" && (input.companyId || input.companyRole)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["companyId"], message: "Company access cannot be combined with instance_admin" });
    }
  });

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
          companyRole: req.body.companyRole as HumanCompanyMembershipRole | undefined,
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

  router.get("/myrmidon/password-set", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      res.status(400).send("Password setup token is required");
      return;
    }
    const escapedToken = JSON.stringify(token).replace(/</g, "\\u003c");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set password</title></head><body><main><h1>Set your password</h1><form id="password-form"><label>New password <input name="password" type="password" minlength="8" required autocomplete="new-password"></label><button>Save password</button><p id="result" role="status"></p></form></main><script>const token=${escapedToken};document.getElementById('password-form').addEventListener('submit',async e=>{e.preventDefault();const p=e.currentTarget.elements.password.value;const r=await fetch('/api/myrmidon/users-admin-a/password-set',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,newPassword:p})});document.getElementById('result').textContent=r.ok?'Password saved. You can now sign in.':'This password link is invalid or expired.';});</script></body></html>`);
  });

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
