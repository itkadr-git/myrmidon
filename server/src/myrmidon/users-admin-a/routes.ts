// myrmidon(OPE-8985): /api/myrmidon/users-admin-a — the server half of the
// "Users" screen (ui/src/pages/UsersAdmin.tsx).
//
//   GET   /users               list users                         (instance admin)
//   POST  /users               create {username,name,password?,role}
//   PATCH /users/:userId       {blocked} and/or {resetPassword: true} -> {passwordSetLink}
//   POST  /password-set        {token,newPassword}  PUBLIC: the one-time token is the proof
//
// Everything except /password-set is instance-admin only (403 otherwise).

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { validate } from "../../middleware/validate.js";
import { assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/index.js";
import { runtimeCanonicalOrigin } from "../../services/cloud-runtime-identity.js";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  UsersAdminError,
  consumePasswordSetToken,
  createUser,
  listUsers,
  resetUserPassword,
  setUserBlocked,
} from "./service.js";

const createUserSchema = z
  .object({
    username: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    password: z.string().max(PASSWORD_MAX).optional().nullable(),
    role: z.enum(["instance_admin", "member"]).default("member"),
  })
  .strict();

const patchUserSchema = z
  .object({ blocked: z.boolean().optional(), resetPassword: z.boolean().optional() })
  .strict()
  .refine((v) => v.blocked !== undefined || v.resetPassword !== undefined, {
    message: "Provide `blocked` or `resetPassword`",
  });

const passwordSetSchema = z
  .object({ token: z.string().min(20).max(200), newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX) })
  .strict();

export interface UsersAdminRoutesOptions {
  authPublicBaseUrl?: string;
}

function baseUrl(req: Request, opts: UsersAdminRoutesOptions): string {
  const runtime = runtimeCanonicalOrigin();
  if (runtime) return runtime;
  if (opts.authPublicBaseUrl) return opts.authPublicBaseUrl.replace(/\/+$/, "");
  const proto = req.header("x-forwarded-proto")?.split(",")[0]?.trim() || req.protocol || "http";
  const host = req.header("x-forwarded-host")?.split(",")[0]?.trim() || req.header("host");
  return host ? `${proto}://${host}` : "";
}

export function passwordSetLink(base: string, token: string): string {
  return `${base}/password-set/${encodeURIComponent(token)}`;
}

/** Instance-level event: one journal entry per company (the journal is per company). */
async function audit(
  db: Db,
  entry: { actorType: "user"; actorId: string; action: string; targetUserId: string; details: Record<string, unknown> },
) {
  const rows = await db.select({ id: companies.id }).from(companies);
  for (const company of rows) {
    await logActivity(db, {
      companyId: company.id,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      entityType: "user",
      entityId: entry.targetUserId,
      details: entry.details,
    });
  }
}

export function usersAdminRoutes(db: Db, opts: UsersAdminRoutesOptions = {}) {
  const router = Router();

  function handle(err: unknown, res: { status: (c: number) => { json: (b: unknown) => void } }) {
    if (err instanceof UsersAdminError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  router.get("/myrmidon/users-admin-a/users", async (req, res) => {
    assertInstanceAdmin(req);
    res.json({ users: await listUsers(db) });
  });

  router.post("/myrmidon/users-admin-a/users", validate(createUserSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const body = req.body as z.infer<typeof createUserSchema>;
    try {
      const { user, token } = await createUser(db, {
        username: body.username,
        name: body.name ?? "",
        password: body.password,
        role: body.role,
        actorUserId: actor.actorId,
      });
      await audit(db, {
        actorType: "user", actorId: actor.actorId, action: "instance.user.created", targetUserId: user.id,
        details: { username: user.username, role: user.role, passwordMode: token ? "set_link" : "direct" },
      });
      res.status(201).json({ ...user, passwordSetLink: token ? passwordSetLink(baseUrl(req, opts), token) : null });
    } catch (err) {
      handle(err, res);
    }
  });

  router.patch("/myrmidon/users-admin-a/users/:userId", validate(patchUserSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const userId = String(req.params.userId);
    const body = req.body as z.infer<typeof patchUserSchema>;
    try {
      const result: Record<string, unknown> = { userId };
      if (body.blocked !== undefined) {
        const { sessionsClosed } = await setUserBlocked(db, { userId, blocked: body.blocked, actorUserId: actor.actorId });
        result.blocked = body.blocked;
        result.sessionsClosed = sessionsClosed;
        await audit(db, {
          actorType: "user", actorId: actor.actorId, targetUserId: userId,
          action: body.blocked ? "instance.user.blocked" : "instance.user.unblocked",
          details: { sessionsClosed },
        });
      }
      if (body.resetPassword) {
        const { token } = await resetUserPassword(db, { userId, actorUserId: actor.actorId });
        result.passwordSetLink = passwordSetLink(baseUrl(req, opts), token);
        await audit(db, {
          actorType: "user", actorId: actor.actorId, targetUserId: userId,
          action: "instance.user.password_reset", details: { via: "set_link" },
        });
      }
      res.json(result);
    } catch (err) {
      handle(err, res);
    }
  });

  // Public: no actor check on purpose. The token is the proof.
  router.post("/myrmidon/users-admin-a/password-set", validate(passwordSetSchema), async (req, res) => {
    const body = req.body as z.infer<typeof passwordSetSchema>;
    try {
      const { userId } = await consumePasswordSetToken(db, body);
      await audit(db, { actorType: "user", actorId: userId, action: "instance.user.password_set", targetUserId: userId, details: { via: "token" } });
      res.json({ ok: true });
    } catch (err) {
      handle(err, res);
    }
  });

  return router;
}
