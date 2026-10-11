// server/src/myrmidon/knowledge/routes.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-11): HTTP surface of "Settings → Knowledge".
//
//   GET   /api/myrmidon/companies/:companyId/knowledge/settings  — any company member
//   PATCH /api/myrmidon/companies/:companyId/knowledge/settings  — instance admin
//
// The GET returns every field with its source badge (`ui`, `env` or `default`).

import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { patchKnowledgeSettingsSchema, type KnowledgeSettingsPatch } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { createKnowledgeSettingsService, type KnowledgeSettingsActor } from "./settings.js";

function handle(
  run: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    try {
      await run(req, res);
    } catch (err) {
      next(err);
    }
  };
}

function actorOf(req: Request): KnowledgeSettingsActor {
  const actor = getActorInfo(req);
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
  };
}

export function myrmidonKnowledgeSettingsRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  const service = createKnowledgeSettingsService(db, env);

  router.get(
    "/myrmidon/companies/:companyId/knowledge/settings",
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res.json(await service.read(companyId));
    }),
  );

  router.patch(
    "/myrmidon/companies/:companyId/knowledge/settings",
    validate(patchKnowledgeSettingsSchema),
    handle(async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      const view = await service.update(companyId, req.body as KnowledgeSettingsPatch, actorOf(req));
      res.json(view);
    }),
  );

  return router;
}
