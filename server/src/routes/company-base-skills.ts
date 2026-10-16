// myrmidon(1.6.5 BASE-SKILLS): the board routes of the company base-skills
// registry — the list every agent carries automatically.
//
// Reads are available to anyone allowed to see the company; the three
// mutations are board-only, because they write into the skill selection of
// every agent of the company at once.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyBaseSkillAddSchema } from "@paperclipai/shared";
import type {
  CompanyBaseSkillMutationResponse,
  CompanyBaseSkillRemoveResponse,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { companyBaseSkillService, type CompanyBaseSkillActor } from "../services/company-base-skills.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function companyBaseSkillRoutes(db: Db) {
  const router = Router();
  const svc = companyBaseSkillService(db);

  function actorFrom(req: Parameters<typeof getActorInfo>[0]): CompanyBaseSkillActor {
    const actor = getActorInfo(req);
    return {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
    };
  }

  router.get("/companies/:companyId/base-skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.overview(companyId));
  });

  router.post(
    "/companies/:companyId/base-skills",
    validate(companyBaseSkillAddSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const added = await svc.add(companyId, req.body.keys, actorFrom(req));
      const body: CompanyBaseSkillMutationResponse = {
        overview: await svc.overview(companyId),
        apply: added.apply,
      };
      res.status(201).json(body);
    },
  );

  router.post("/companies/:companyId/base-skills/apply", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const apply = await svc.applyToCompanyAgents(companyId, actorFrom(req));
    const body: CompanyBaseSkillMutationResponse = {
      overview: await svc.overview(companyId),
      apply,
    };
    res.json(body);
  });

  router.delete("/companies/:companyId/base-skills/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    const key = req.params.key as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const removed = await svc.remove(companyId, key, actorFrom(req));
    if (!removed) {
      res.status(404).json({ error: "This skill is not a company base skill." });
      return;
    }
    const body: CompanyBaseSkillRemoveResponse = {
      overview: await svc.overview(companyId),
      removed: removed.key,
    };
    res.json(body);
  });

  return router;
}