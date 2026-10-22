// GET /api/myrmidon/companies/:companyId/foraging/passes
// (myrmidon 1.6.3 FORAGING-IDLE-GATE, UI half).
//
// The pass history of one company, newest first: what each pass read and which
// roles it left alone, with the reason. Read-only — the passes are recorded by
// the pass itself, and the audit trail of a manual pass stays in the activity
// log. Company access applies, the same rule as the other foraging reads.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { FORAGING_PASS_JOURNAL_LIMIT } from "@paperclipai/shared";
import { assertCompanyAccess } from "../../routes/authz.js";
import type { ForagingPassJournalService } from "./pass-journal.js";

export function foragingPassRoutes(_db: Db, journal: ForagingPassJournalService) {
  const router = Router();

  router.get("/myrmidon/companies/:companyId/foraging/passes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), FORAGING_PASS_JOURNAL_LIMIT)
        : FORAGING_PASS_JOURNAL_LIMIT;
    res.json({ passes: await journal.read(companyId, limit) });
  });

  return router;
}