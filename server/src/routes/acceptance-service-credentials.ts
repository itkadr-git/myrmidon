import { Router } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { isUuidLike } from "@myrmidon/shared";
import { badRequest, notFound } from "../errors.js";
import { acceptanceServiceCredentialsService } from "../services/acceptance-service-credentials.js";
import { logActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const issueSchema = z.object({
  certificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export function acceptanceServiceCredentialRoutes(db: Db) {
  const router = Router();
  const path = "/companies/:companyId/acceptance-service-credentials";

  router.post(path, async (req, res) => {
    assertAuthenticated(req);
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const parsed = issueSchema.safeParse(req.body);
    if (!parsed.success || new Date(parsed.data.expiresAt).getTime() <= Date.now()) throw badRequest("Invalid certificate fingerprint or expiry");
    const actor = getActorInfo(req);
    const publications: ActivityPublication[] = [];
    const issued = await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      const result = await acceptanceServiceCredentialsService(transactionDb).issue(companyId, parsed.data.certificateSha256, new Date(parsed.data.expiresAt));
      await logActivity(transactionDb, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "acceptance_service_credential.issued", entityType: "acceptance_service_credential", entityId: result.id }, publications);
      return result;
    });
    publications.forEach(publishActivity);
    res.set("Cache-Control", "no-store").status(201).json(issued);
  });

  router.delete(`${path}/:id`, async (req, res) => {
    assertAuthenticated(req);
    assertBoard(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    const id = String(req.params.id);
    if (!isUuidLike(id)) throw notFound("Credential not found");
    const actor = getActorInfo(req);
    const publications: ActivityPublication[] = [];
    await db.transaction(async (tx) => {
      const transactionDb = tx as unknown as Db;
      if (!await acceptanceServiceCredentialsService(transactionDb).revoke(companyId, id)) throw notFound("Credential not found");
      await logActivity(transactionDb, { companyId, actorType: actor.actorType, actorId: actor.actorId, action: "acceptance_service_credential.revoked", entityType: "acceptance_service_credential", entityId: id }, publications);
    });
    publications.forEach(publishActivity);
    res.status(204).end();
  });
  return router;
}
