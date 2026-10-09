// server/src/myrmidon/wake-task-guard-routes.ts
//
// myrmidon(1.6.5 F-26 T5): the read side of the wake guard for the T4 swarm
// panel (design §3.7/§4.3). One GET: the tasks currently in a cooling window,
// each with the trigger reason, the number of consecutive stale runs, the
// window length and the time of the next allowed automatic wake. Read-only —
// the cooling itself is enforced in wake-task-guard.ts; this only shows what
// that module decides, so an operator can answer "why is this task not being
// woken" without reading server logs.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertCompanyAccess } from "../routes/authz.js";
import { listCoolingIssues, readSwarmSettings } from "./wake-task-guard.js";

export function myrmidonWakeTaskGuardRoutes(db: Db): Router {
  const router = Router();

  router.get(
    "/myrmidon/companies/:companyId/swarm/cooling",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const settings = await readSwarmSettings(db);
      const issues = await listCoolingIssues(db, companyId, settings);
      res.json({
        settings: {
          runWithoutTaskGate: settings.runWithoutTaskGate,
          cooldownBaseMin: settings.cooldownBaseMin,
          cooldownCeilingHours: settings.cooldownCeilingHours,
        },
        cooling: issues.map((row) => ({
          ...row,
          nextWakeAt: row.nextWakeAt?.toISOString() ?? null,
        })),
      });
    },
  );

  return router;
}
