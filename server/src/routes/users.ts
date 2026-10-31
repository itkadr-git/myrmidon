import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { updateCompanyMemberSchema } from "@myrmidon/shared";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { forbidden, notFound, unauthorized } from "../errors.js";

/**
 * myrmidon(OPE-10179): PATCH /api/companies/:companyId/users/:userId — a thin
 * alias over the canonical member route. Suspend/activate flow through
 * `access.updateMember`, which revokes all of the user's sessions and board
 * API keys (session-service) as soon as the status becomes `suspended`.
 */
export function usersRoutes(db: Db): Router {
  const router = Router();
  const access = accessService(db);

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
