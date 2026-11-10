import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { blockUserSchema, patchUserBlockSchema, updateCompanyMemberSchema } from "@myrmidon/shared";
import { companies, invites } from "@myrmidon/db";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { getUser, listUsers, resetUserPassword, setUserBlocked, UsersAdminError } from "../myrmidon/users-admin-a/service.js";
import { logActivity } from "../services/activity-log.js";

function assertAdmin(req: import("express").Request) {
  if (!req.actor || req.actor.type === "none") {
    throw unauthorized();
  }
  const a = req.actor as unknown as { type?: string; isInstanceAdmin?: boolean; source?: string };
  if (
    (a.type === "board" || a.type === "user") &&
    (a.isInstanceAdmin === true || a.source === "local_implicit")
  ) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function getAdminActorId(req: import("express").Request): string {
  const a = req.actor as unknown as { userId?: string; actorId?: string };
  if (a?.userId) return a.userId;
  if (a?.actorId) return a.actorId;
  return "system";
}

/**
 * Audit helper: writes an instance-level user activity event for all companies,
 * ensuring at least one record is stored even if no companies exist yet.
 */
async function auditUserBlock(
  db: Db,
  entry: {
    actorId: string;
    targetUserId: string;
    action: string;
    details: Record<string, unknown>;
  },
) {
  let rows = await db.select({ id: companies.id }).from(companies);
  if (rows.length === 0) {
    const [created] = await db.insert(companies).values({ name: "Default" }).returning({ id: companies.id });
    if (created) rows = [created];
  }
  for (const company of rows) {
    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: entry.actorId,
      action: entry.action,
      entityType: "user",
      entityId: entry.targetUserId,
      details: entry.details,
    });
  }
}

const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  role: z.enum(["admin", "instance_admin", "member"]).optional(),
});

/**
 * myrmidon 1.7 USERS-ADMIN-INVITE (OPE-12090): DTO for POST /api/users/invite.
 * The role vocabulary matches the instance-admin user management surface
 * (`instance_admin` | `member`); anything else is rejected with 400 by zod.
 */
const inviteUserSchema = z
  .object({
    email: z.string().trim().email().max(320),
    role: z.enum(["member", "instance_admin"]).default("member"),
  })
  .strict();

const INVITE_TOKEN_PREFIX = "pcp_invite_";
const INVITE_TOKEN_ENTROPY_BYTES = 32;
const USER_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

function newInviteToken(): string {
  const suffix = randomBytes(INVITE_TOKEN_ENTROPY_BYTES).toString("base64url");
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * myrmidon(OPE-10179): PATCH /api/companies/:companyId/users/:userId — a thin
 * alias over the canonical member route. Suspend/activate flow through
 * `access.updateMember`, which revokes all of the user's sessions and board
 * API keys (session-service) as soon as the status becomes `suspended`.
 * myrmidon(OPE-10215): API operator for administrator user blocking with mandatory reason and audit logging.
 */
export function usersRoutes(db: Db): Router {
  const router = Router();
  const access = accessService(db);

  function handleUsersAdminError(err: unknown, res: import("express").Response) {
    if (err instanceof UsersAdminError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }

  /**
   * GET /api/users
   * Instance administrator route to list users with pagination and role filter.
   * (myrmidon 1.7 USERS-ADMIN-PAGINATION, OPE-12089)
   */
  router.get("/users", async (req, res) => {
    assertAdmin(req);
    const parsed = listUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "Validation error",
        message: "Validation error",
        code: "VALIDATION_ERROR",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { page, limit, role } = parsed.data;
    const { users, total } = await listUsers(db, { page, limit, role });
    res.status(200).json({
      items: users,
      users,
      total,
      page,
      limit,
    });
  });

  /**
   * POST /api/users/:userId/block
   * Instance administrator route to block a user with required reason and audit.
   */
  router.post(
    "/users/:userId/block",
    validate(blockUserSchema),
    async (req, res) => {
      assertAdmin(req);
      const userId = req.params.userId as string;
      const actorUserId = getAdminActorId(req);
      const reason = req.body.reason as string;

      try {
        const user = await getUser(db, userId);
        if (!user) throw notFound("User not found");

        if (userId === actorUserId) {
          res.status(409).json({ error: "You cannot block yourself", code: "CONFLICT" });
          return;
        }

        const { sessionsClosed } = await setUserBlocked(db, {
          userId,
          blocked: true,
          actorUserId,
          reason,
        });

        await auditUserBlock(db, {
          actorId: actorUserId,
          targetUserId: userId,
          action: "user.blocked",
          details: {
            actor: actorUserId,
            target: userId,
            reason,
            sessionsClosed,
          },
        });

        res.status(200).json({
          ok: true,
          userId,
          blocked: true,
          reason,
          sessionsClosed,
        });
      } catch (err) {
        handleUsersAdminError(err, res);
      }
    },
  );

  /**
   * PATCH /api/users/:userId/block
   * Instance administrator route to block or unblock a user with audit logging.
   * (myrmidon 1.7 USERS-ADMIN-BLOCK, OPE-12116)
   */
  router.patch(
    "/users/:userId/block",
    validate(patchUserBlockSchema),
    async (req, res) => {
      assertAdmin(req);
      const userId = req.params.userId as string;
      const actorUserId = getAdminActorId(req);
      const blocked = req.body.blocked ?? true;
      const reason = req.body.reason ? String(req.body.reason).trim() : null;

      try {
        const user = await getUser(db, userId);
        if (!user) throw notFound("User not found");

        if (blocked && userId === actorUserId) {
          res.status(409).json({ error: "You cannot block yourself", code: "CONFLICT" });
          return;
        }

        const { sessionsClosed } = await setUserBlocked(db, {
          userId,
          blocked,
          actorUserId,
          reason,
        });

        await auditUserBlock(db, {
          actorId: actorUserId,
          targetUserId: userId,
          action: blocked ? "user.blocked" : "user.unblocked",
          details: {
            actor: actorUserId,
            target: userId,
            ...(reason ? { reason } : {}),
            sessionsClosed,
          },
        });

        res.status(200).json({
          ok: true,
          userId,
          blocked,
          ...(reason ? { reason } : {}),
          sessionsClosed,
        });
      } catch (err) {
        handleUsersAdminError(err, res);
      }
    },
  );

  /**
   * POST /api/users/:userId/reset-password
   * Instance administrator route to issue a one-time password reset token without SMTP.
   * (myrmidon 1.7 USERS-ADMIN-BLOCK, OPE-12116)
   */
  router.post(
    "/users/:userId/reset-password",
    async (req, res) => {
      assertAdmin(req);
      const userId = req.params.userId as string;
      const actorUserId = getAdminActorId(req);

      try {
        const user = await getUser(db, userId);
        if (!user) throw notFound("User not found");

        const result = await resetUserPassword(db, {
          userId,
          actorUserId,
        });

        await auditUserBlock(db, {
          actorId: actorUserId,
          targetUserId: userId,
          action: "user.password_reset",
          details: {
            actor: actorUserId,
            target: userId,
            via: "reset_token",
          },
        });

        res.status(200).json({
          ok: true,
          userId,
          token: result.token,
          resetToken: result.token,
          passwordSetLink: result.passwordSetLink,
        });
      } catch (err) {
        handleUsersAdminError(err, res);
      }
    },
  );

  /**
   * POST /api/users/invite
   * Instance administrator route to invite a user by email without SMTP.
   * Creates an invite token and returns it in the response; no email is sent.
   * (myrmidon 1.7 USERS-ADMIN-INVITE, OPE-12090)
   */
  router.post(
    "/users/invite",
    validate(inviteUserSchema),
    async (req, res) => {
      assertAdmin(req);
      const actorUserId = getAdminActorId(req);
      const { email, role } = req.body as z.infer<typeof inviteUserSchema>;

      const token = newInviteToken();
      const expiresAt = new Date(Date.now() + USER_INVITE_TTL_MS);
      const defaultsPayload: Record<string, unknown> = {
        invitedEmail: email,
        invitedRole: role,
      };

      const created = await db
        .insert(invites)
        .values({
          companyId: null,
          inviteType: "user_invite",
          tokenHash: hashInviteToken(token),
          allowedJoinTypes: "human",
          defaultsPayload,
          expiresAt,
          invitedByUserId: actorUserId,
        })
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!created) {
        res.status(500).json({ error: "Failed to create invite", code: "INTERNAL_ERROR" });
        return;
      }

      await auditUserBlock(db, {
        actorId: actorUserId,
        targetUserId: created.id,
        action: "user.invited",
        details: {
          actor: actorUserId,
          inviteId: created.id,
          email,
          role,
          expiresAt: expiresAt.toISOString(),
        },
      });

      res.status(201).json({
        ok: true,
        inviteId: created.id,
        email,
        role,
        token,
        inviteUrl: `/invite/${token}`,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  /**
   * POST /api/companies/:companyId/users/:userId/block
   * Company/instance administrator route to block a user within a company scope with required reason and audit.
   */
  router.post(
    "/companies/:companyId/users/:userId/block",
    validate(blockUserSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") throw unauthorized();
      const allowed =
        req.actor.isInstanceAdmin ||
        (await access.canUser(companyId, req.actor.userId, "users:manage_permissions"));
      if (!allowed) throw forbidden("Administrator access required");

      const actorUserId = getAdminActorId(req);
      const reason = req.body.reason as string;

      try {
        const user = await getUser(db, userId);
        if (!user) throw notFound("User not found");

        if (userId === actorUserId) {
          res.status(409).json({ error: "You cannot block yourself", code: "CONFLICT" });
          return;
        }

        const { sessionsClosed } = await setUserBlocked(db, {
          userId,
          blocked: true,
          actorUserId,
          reason,
        });

        // Also suspend company membership if present
        const member = await access.getMembership(companyId, "user", userId);
        if (member && member.status !== "suspended") {
          await access.updateMember(companyId, member.id, { status: "suspended" });
        }

        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "user.blocked",
          entityType: "user",
          entityId: userId,
          details: {
            actor: actorUserId,
            target: userId,
            reason,
            sessionsClosed,
          },
        });

        res.status(200).json({
          ok: true,
          userId,
          blocked: true,
          reason,
          sessionsClosed,
        });
      } catch (err) {
        handleUsersAdminError(err, res);
      }
    },
  );

  /**
   * myrmidon(OPE-10179): PATCH /api/companies/:companyId/users/:userId — a thin
   * alias over the canonical member route. Suspend/activate flow through
   * `access.updateMember`, which revokes all of the user's sessions and board
   * API keys (session-service) as soon as the status becomes `suspended`.
   */
  router.patch(
    "/companies/:companyId/users/:userId",
    validate(updateCompanyMemberSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const userId = req.params.userId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type !== "board") throw unauthorized();
      const allowed =
        req.actor.isInstanceAdmin ||
        (await access.canUser(companyId, req.actor.userId, "users:manage_permissions"));
      if (!allowed) throw forbidden("Permission denied");

      const member = await access.getMembership(companyId, "user", userId);
      if (!member) throw notFound("Member not found");
      const updated = await access.updateMember(companyId, member.id, req.body);
      if (!updated) throw notFound("Member not found");
      res.json(updated);
    },
  );

  return router;
}

export const userRoutes = usersRoutes;
