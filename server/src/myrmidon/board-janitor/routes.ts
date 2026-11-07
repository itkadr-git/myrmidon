// myrmidon(BOARD-JANITOR): HTTP routes for manual / on-demand trigger ("по кнопке")

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertCompanyAccess } from "../../routes/authz.js";
import { createBoardJanitorSweep } from "./sweep.js";

const runJanitorSchema = z.object({
  companyId: z.string().uuid().optional(),
  dryRun: z.boolean().optional(),
  onlyIssueIds: z.array(z.string().uuid()).optional(),
});

export function boardJanitorRoutes(db: Db) {
  const router = Router();
  const sweep = createBoardJanitorSweep({ db });

  // On-demand trigger across instance / specified company: POST /api/myrmidon/board-janitor/run
  router.post("/myrmidon/board-janitor/run", validate(runJanitorSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    const body = req.body as z.infer<typeof runJanitorSchema>;

    let companyId = body.companyId;
    if (!companyId) {
      // Find the first/main company
      const { companies } = await import("@myrmidon/db");
      const [firstCompany] = await db.select({ id: companies.id }).from(companies).limit(1);
      if (!firstCompany) {
        return res.status(404).json({ error: "No company found" });
      }
      companyId = firstCompany.id;
    }

    const result = await sweep({
      companyId,
      dryRun: body.dryRun ?? false,
      onlyIssueIds: body.onlyIssueIds,
    });

    res.json(result);
  });

  // Company-scoped trigger: POST /api/companies/:companyId/board-janitor/run
  router.post("/companies/:companyId/board-janitor/run", validate(runJanitorSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body = req.body as z.infer<typeof runJanitorSchema>;

    const result = await sweep({
      companyId,
      dryRun: body.dryRun ?? false,
      onlyIssueIds: body.onlyIssueIds,
    });

    res.json(result);
  });

  return router;
}
