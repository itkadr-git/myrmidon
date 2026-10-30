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
        const view = await service.get(companyId);
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

        let actor: KnowledgeSettingsActor | undefined;
        try {
          const info = getActorInfo(req);
          actor = { actorType: info.actorType, actorId: info.actorId };
        } catch {
          // implicit/testing
        }

        const view = await service.patch(companyId, req.body ?? {}, actor);
        res.json(view);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
