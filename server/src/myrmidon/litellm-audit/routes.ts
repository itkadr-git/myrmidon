// server/src/myrmidon/litellm-audit/routes.ts
//
// myrmidon(OPE-9857): REST API for LiteLLM settings audit log and safe rollback.

import { Router } from "express";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { badRequest } from "../../errors.js";
import type { LiteLlmAuditCategory } from "./types.js";
import type { LiteLlmAuditService, LiteLlmRollbackHandlers } from "./service.js";

export interface LitellmAuditRoutesDeps {
  service: LiteLlmAuditService;
  handlers?: LiteLlmRollbackHandlers;
}

export function litellmAuditRoutes(deps: LitellmAuditRoutesDeps): Router {
  const router = Router();

  // GET /myrmidon/companies/:companyId/litellm/audit
  router.get("/myrmidon/companies/:companyId/litellm/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const categoryParam = typeof req.query.category === "string" ? req.query.category : undefined;
    let category: LiteLlmAuditCategory | undefined;
    if (categoryParam) {
      if (categoryParam !== "models" && categoryParam !== "fallbacks" && categoryParam !== "keys") {
        throw badRequest(`invalid category "${categoryParam}"; must be models, fallbacks, or keys`);
      }
      category = categoryParam as LiteLlmAuditCategory;
    }

    const limitParam = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isFinite(limitParam) ? limitParam : 50;

    const entries = await deps.service.list(companyId, { category, limit });
    res.json({ entries });
  });

  // POST /myrmidon/companies/:companyId/litellm/audit/:auditId/rollback
  router.post("/myrmidon/companies/:companyId/litellm/audit/:auditId/rollback", async (req, res) => {
    const companyId = req.params.companyId as string;
    const auditId = req.params.auditId as string;
    assertCompanyAccess(req, companyId);
    // Safe rollback requires board authorization (re-authorization gate)
    assertBoard(req);

    const actorInfo = getActorInfo(req);
    const actor = {
      type: actorInfo.actorType,
      id: actorInfo.actorId,
      name: "userId" in req.actor ? (req.actor.userId as string) : actorInfo.actorId,
    };

    const result = await deps.service.rollback(
      {
        companyId,
        auditId,
        actor,
      },
      deps.handlers,
    );

    res.json(result);
  });

  return router;
}
