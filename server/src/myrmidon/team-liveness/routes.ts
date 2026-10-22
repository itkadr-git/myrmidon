// GET/PATCH /api/myrmidon/team-liveness (myrmidon TEAM-LIVENESS-SETTINGS).
//
// GET reports the effective knobs of the three automatic team-liveness
// behaviours, which keys the instance has saved, and — per key — whether the
// stored value, the environment or the built-in default is in force. PATCH
// The metrics route reports the 24-hour counters of the three behaviours for
// one company: auto-resumes, wakes and stalled runs (TEAM-LIVENESS-METRICS).
// PATCH writes `instance_settings.general.teamLiveness`; it is instance-admin only,
// the same rule the rest of the instance settings follow. No live apply step:
// the three sweeps read the row on every pass
// (`team-liveness/settings.ts`), so a change takes effect on the next pass.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  patchTeamLivenessSettingsSchema,
  type TeamLivenessSettingsPatch,
} from "@paperclipai/shared";
import { badRequest } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import {
  assertBoard,
  assertBoardOrgAccess,
  assertCompanyAccess,
  assertInstanceAdmin,
  getActorInfo,
} from "../../routes/authz.js";
import { readTeamLivenessMetrics } from "./metrics.js";
import type { TeamLivenessService } from "./service.js";

export function teamLivenessRoutes(db: Db, service: TeamLivenessService) {
  const router = Router();

  router.get("/myrmidon/team-liveness", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(await service.read());
  });

  // The 24-hour counters behind the health card. Company-scoped: the board
  // reads one company's window, the same access rule the fleet console uses.
  router.get("/myrmidon/team-liveness/metrics", async (req, res) => {
    assertBoard(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
    if (!companyId) throw badRequest("companyId is required");
    assertCompanyAccess(req, companyId);
    res.json(await readTeamLivenessMetrics(db, companyId));
  });

  router.patch(
    "/myrmidon/team-liveness",
    validate(patchTeamLivenessSettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.update(req.body as TeamLivenessSettingsPatch, getActorInfo(req)));
    },
  );

  return router;
}
