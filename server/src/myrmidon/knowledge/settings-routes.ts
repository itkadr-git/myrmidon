// server/src/myrmidon/knowledge/settings-routes.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): the HTTP surface of the "Settings → Knowledge"
// screen. Mounted on the main api router at /api/myrmidon/companies/:companyId/knowledge/settings.
//
// Wire contract:
//   GET   /api/myrmidon/companies/:companyId/knowledge/settings
//     -> 200 { view: KnowledgeSettingsView }
//   PATCH /api/myrmidon/companies/:companyId/knowledge/settings
//     -> 200 { view: KnowledgeSettingsView }
//
// Auth: company-access check; PATCH additionally requires instance:admin so
// non-admins cannot mutate company knowledge limits or schedules.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { createKnowledgeSettingsService, type KnowledgeSettingsActor } from "./settings.js";

export function myrmidonKnowledgeSettingsRoutes(
  db: Db,
  env: NodeJS.ProcessEnv = process.env,
): Router {
  const router = Router();
  const service = createKnowledgeSettingsService(db, env);

  router.get(
    "/myrmidon/companies/:companyId/knowledge/settings",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        const view = await service.read(companyId);
        res.json(view);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/myrmidon/companies/:companyId/knowledge/settings",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        assertInstanceAdmin(req);

        const info = getActorInfo(req);
        const actor: KnowledgeSettingsActor = {
          actorType: info.actorType,
          actorId: info.actorId,
          agentId: info.actorType === "agent" ? info.agentId : null,
          runId: info.actorType === "agent" ? info.runId : null,
        };

        const view = await service.update(companyId, req.body ?? {}, actor);
        res.json(view);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
