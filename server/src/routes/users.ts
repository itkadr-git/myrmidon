import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { blockUserSchema, updateCompanyMemberSchema } from "@myrmidon/shared";
import { companies } from "@myrmidon/db";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { getUser, setUserBlocked, UsersAdminError } from "../myrmidon/users-admin-a/service.js";
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
