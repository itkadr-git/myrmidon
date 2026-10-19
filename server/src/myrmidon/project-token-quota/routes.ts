// server/src/myrmidon/project-token-quota/routes.ts
//
// myrmidon(1.6.6 QUOTA-V2): the project token quota read/write API.
//
// - GET  /api/myrmidon/companies/:companyId/projects/:projectId/token-quota —
//   the quota plus the live usage counters of both windows. Any company
//   member reads.
// - PUT  /api/myrmidon/companies/:companyId/projects/:projectId/token-quota —
//   the quota body `{ dailyTokenLimit, weeklyTokenLimit }` (null = unlimited).
//   Instance admins write, the same rule the other company-scoped myrmidon
//   surfaces follow.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { projectTokenQuotaSchema } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { readProjectTokenQuotaStatus, upsertProjectTokenQuota } from "./service.js";

export function projectTokenQuotaRoutes(db: Db) {
  const router = Router();

  router.get("/myrmidon/companies/:companyId/projects/:projectId/token-quota", async (req, res) => {
    const companyId = req.params.companyId as string;
    const projectId = req.params.projectId as string;
    assertCompanyAccess(req, companyId);
    res.json(await readProjectTokenQuotaStatus(db, companyId, projectId));
  });

  router.put(
    "/myrmidon/companies/:companyId/projects/:projectId/token-quota",
    validate(projectTokenQuotaSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const projectId = req.params.projectId as string;
      assertCompanyAccess(req, companyId);
      assertInstanceAdmin(req);
      const actorUserId =
        req.actor.type === "board" && typeof req.actor.userId === "string" ? req.actor.userId : null;
      const quota = await upsertProjectTokenQuota(db, companyId, projectId, req.body, actorUserId);
      const status = await readProjectTokenQuotaStatus(db, companyId, projectId);
      res.json({ ...quota, projectName: status.projectName });
    },
  );

  return router;
}
