// myrmidon(REVIEW-ROUTING): the settings API of the review routing.
//
// - GET /api/myrmidon/companies/:companyId/review-routing/settings
// - PUT /api/myrmidon/companies/:companyId/review-routing/settings
//
// Any company member reads; instance admins write (the rule the WIP limit and
// the other company-scoped myrmidon settings follow). The values are stored
// on the instance, so one setting applies to every company of the instance.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { reviewRoutingSettingsSchema } from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess, assertInstanceAdmin } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { readReviewRoutingSettings, writeReviewRoutingSettings } from "./settings.js";

export function reviewRoutingRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  router.get("/myrmidon/companies/:companyId/review-routing/settings", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId as string);
    res.json(await readReviewRoutingSettings(settings));
  });

  router.put(
    "/myrmidon/companies/:companyId/review-routing/settings",
    validate(reviewRoutingSettingsSchema),
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      assertInstanceAdmin(req);
      res.json(await writeReviewRoutingSettings(settings, req.body));
    },
  );

  return router;
}
