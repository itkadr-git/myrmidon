import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import {
  ADM_COMPANY_ID_ENV,
  admAccessRequestScopeSchema,
  createAdmAccessRequestSchema,
  decideAdmAccessRequestSchema,
  executeAdmCapabilitySchema,
  revokeAdmAccessRequestSchema,
} from "@myrmidon/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { admAccessRequestService, type AdmActorContext } from "../services/adm-access-request.js";
import { forbidden } from "../errors.js";

function admCompanyId(): string | null {
  const raw = process.env[ADM_COMPANY_ID_ENV]?.trim() ?? "";
  return raw.length > 0 ? raw : null;
}

/**
 * 1.7 COMPANY-BOUNDARIES (OPE-12766, ADR-0052): the only cross-company
 * control channel. Every route is deny-by-default on company boundaries:
 * the caller must already have access to its own company, agent keys can
 * never speak for another company, and the ADM decision plane is reachable
 * only from the configured ADM company (or an instance admin on the board).
 */
export function admAccessRequestRoutes(db: Db) {
  const router = Router();
  const svc = admAccessRequestService(db);

  function admActor(req: Request): AdmActorContext {
    const actor = getActorInfo(req);
    return {
      companyId: req.actor.companyId ?? (actor.actorType === "agent" ? actor.actorId : ""),
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId,
      isInstanceAdmin: req.actor.isInstanceAdmin === true,
    };
  }

  router.post("/companies/:companyId/adm/access-requests", validate(createAdmAccessRequestSchema), async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      // Deny-by-default: the caller must belong to the source company.
      if (!hasCompanyAccess(req, companyId)) {
        throw forbidden("Access denied");
      }
      assertCompanyAccess(req, companyId);
      if (admCompanyId() && req.body.targetCompanyId !== admCompanyId()) {
        // ADR-0052: the target is always the ADM control-plane company;
        // source agents cannot pick arbitrary target companies.
        throw forbidden("Access requests may only target the ADM control-plane company");
      }
      const parsed = admAccessRequestScopeSchema.parse(req.body.requestedScope);
      const { request, isExisting } = await svc.create(companyId, { ...req.body, requestedScope: parsed }, admActor(req));
      res.status(isExisting ? 200 : 201).json({ ...request, isExisting });
    } catch (error) {
      next(error);
    }
  });

  router.get("/companies/:companyId/adm/access-requests", async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      if (!hasCompanyAccess(req, companyId)) {
        throw forbidden("Access denied");
      }
      assertCompanyAccess(req, companyId);
      res.json(await svc.list(companyId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/adm/access-requests/:id", async (req, res, next) => {
    try {
      const actor = getActorInfo(req);
      const companyId = req.actor.companyId
        ?? (req.actor.companyIds ?? [])[0]
        ?? "";
      if (!companyId || !hasCompanyAccess(req, companyId)) {
        throw forbidden("Access denied");
      }
      const request = await svc.getById(req.params.id as string, companyId);
      // Existence-oracle guard: unknown and forbidden ids answer identically.
      if (!request) {
        res.status(404).json({ error: "Access request not found" });
        return;
      }
      res.json(request);
      void actor;
    } catch (error) {
      next(error);
    }
  });

  router.post("/adm/access-requests/:id/decide", validate(decideAdmAccessRequestSchema), async (req, res, next) => {
    try {
      const targetCompanyId = admCompanyId();
      if (!targetCompanyId) {
        throw forbidden("ADM control-plane company is not configured");
      }
      // Only ADM company operators can decide. Agent keys never act as ADM operators.
      if (req.actor.type !== "board") {
        throw forbidden("Only ADM company operators can decide access requests");
      }
      if (
        req.actor.source !== "local_implicit"
        && !req.actor.isInstanceAdmin
        && !(req.actor.companyIds ?? []).includes(targetCompanyId)
      ) {
        throw forbidden("Only ADM company operators can decide access requests");
      }
      const result = await svc.decide(
        req.params.id as string,
        targetCompanyId,
        req.body,
        admActor(req),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/companies/:companyId/adm/access-requests/:id/revoke", validate(revokeAdmAccessRequestSchema), async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      if (!hasCompanyAccess(req, companyId)) {
        throw forbidden("Access denied");
      }
      assertCompanyAccess(req, companyId);
      const request = await svc.revoke(req.params.id as string, companyId, req.body, admActor(req));
      res.json(request);
    } catch (error) {
      next(error);
    }
  });

  router.post("/companies/:companyId/adm/capability/execute", validate(executeAdmCapabilitySchema), async (req, res, next) => {
    try {
      const companyId = req.params.companyId as string;
      // Audience binding at the route level: the capability executes only in
      // the source company namespace; the service re-checks the claims.
      if (!hasCompanyAccess(req, companyId)) {
        throw forbidden("Access denied");
      }
      assertCompanyAccess(req, companyId);
      const result = await svc.executeCapability(req.body, admActor(req));
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
